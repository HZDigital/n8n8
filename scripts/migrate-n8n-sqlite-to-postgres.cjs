#!/usr/bin/env node

/*
 * Migrate n8n data from SQLite to PostgreSQL.
 *
 * Usage:
 *   node scripts/migrate-n8n-sqlite-to-postgres.cjs \
 *     --sqlite /path/to/database.sqlite \
 *     --postgres "postgresql://user:pass@host:5432/db"
 *
 * Notes:
 * - Target PostgreSQL DB must already be initialized by the same n8n version.
 * - This script truncates target tables before import.
 */

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { Client } = require('pg');

function parseArgs(argv) {
	const args = {
		sqlite: '',
		postgres: '',
		batchSize: 500,
		dryRun: false,
		skipFkErrors: false,
		skipTables: new Set(),
		onlyTables: new Set(),
		resume: false,
		skipSqliteErrors: false,
		skipOverflowErrors: false,
		excludeColumns: new Set(),
	};

	for (let i = 2; i < argv.length; i++) {
		const raw = argv[i] ?? '';
		const current = String(raw)
			.trim()
			.replaceAll('\u2013', '-')
			.replaceAll('\u2014', '-');

		if (current === '--sqlite') {
			args.sqlite = argv[++i] ?? '';
		} else if (current === '--postgres') {
			args.postgres = argv[++i] ?? '';
		} else if (current === '--batch-size') {
			args.batchSize = Number.parseInt(argv[++i] ?? '500', 10);
		} else if (current === '--dry-run') {
			args.dryRun = true;
		} else if (current === '--skip-fk-errors') {
			args.skipFkErrors = true;
		} else if (current === '--skip-tables') {
			const rawTables = String(argv[++i] ?? '');
			const parts = rawTables
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			args.skipTables = new Set(parts);
		} else if (current === '--only-tables') {
			const rawTables = String(argv[++i] ?? '');
			const parts = rawTables
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			args.onlyTables = new Set(parts);
		} else if (current === '--resume') {
			args.resume = true;
		} else if (current === '--skip-sqlite-errors') {
			args.skipSqliteErrors = true;
		} else if (current === '--skip-overflow-errors') {
			args.skipOverflowErrors = true;
		} else if (current === '--exclude-columns') {
			const rawColumns = String(argv[++i] ?? '');
			const parts = rawColumns
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			args.excludeColumns = new Set(parts);
		} else if (current === '--help' || current === '-h') {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${current}`);
		}
	}

	if (!args.sqlite || !args.postgres) {
		printHelp();
		throw new Error('Missing required arguments --sqlite and --postgres');
	}

	if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
		throw new Error('Invalid --batch-size value. It must be a positive integer.');
	}

	return args;
}

function printHelp() {
	console.log(`
Migrate n8n SQLite DB to PostgreSQL

Required:
  --sqlite <path>           Path to n8n SQLite DB (database.sqlite)
  --postgres <url>          PostgreSQL connection URL

Optional:
  --batch-size <number>     Rows per insert batch (default: 500)
  --dry-run                 Show planned actions, do not write to PostgreSQL
  --skip-fk-errors          Skip rows that violate FK constraints
  --skip-tables <a,b,c>     Comma-separated list of tables to skip
  --only-tables <a,b,c>     Comma-separated list of tables to migrate
  --resume                  Do not truncate; inserts use ON CONFLICT DO NOTHING
  --skip-sqlite-errors      Skip unreadable/corrupt SQLite tables
  --skip-overflow-errors    Skip rows exceeding Postgres varchar limits
  --exclude-columns <a.b>   Comma-separated table.column list to skip on insert
  -h, --help                Show this help

Example:
  node scripts/migrate-n8n-sqlite-to-postgres.cjs \\
    --sqlite /root/database.sqlite \\
    --postgres postgresql://n8n:n8n@localhost:5432/n8n
`);
}

function quoteIdent(identifier) {
	return `"${String(identifier).replaceAll('"', '""')}"`;
}

function openSqlite(sqlitePath) {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY, (err) => {
			if (err) reject(err);
			else resolve(db);
		});
	});
}

function sqliteAll(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});
}

function sqliteGet(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, row) => {
			if (err) reject(err);
			else resolve(row);
		});
	});
}

function sqliteClose(db) {
	return new Promise((resolve, reject) => {
		db.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function coerceValue(value, pgType) {
	if (value === null || value === undefined) return null;

	if (pgType === 'boolean') {
		if (typeof value === 'boolean') return value;
		if (typeof value === 'number') return value !== 0;
		if (typeof value === 'string') {
			if (value === '1' || value.toLowerCase() === 'true') return true;
			if (value === '0' || value.toLowerCase() === 'false') return false;
		}
	}

	return value;
}

function buildInsertStatement(table, columns, rowCount, options = {}) {
	const { onConflictDoNothing = false } = options;
	const quotedColumns = columns.map(quoteIdent).join(', ');
	const valuesChunks = [];
	let placeholderIndex = 1;

	for (let r = 0; r < rowCount; r++) {
		const placeholders = [];
		for (let c = 0; c < columns.length; c++) {
			placeholders.push(`$${placeholderIndex++}`);
		}
		valuesChunks.push(`(${placeholders.join(', ')})`);
	}

	const conflictClause = onConflictDoNothing ? ' ON CONFLICT DO NOTHING' : '';
	return `INSERT INTO ${quoteIdent(table)} (${quotedColumns}) VALUES ${valuesChunks.join(', ')}${conflictClause}`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryablePgConnectionError(error) {
	if (!error) return false;

	if (typeof error.code === 'string') {
		if (error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.code === 'ETIMEDOUT') return true;
		if (error.code === '57P01' || error.code === '57P02' || error.code === '57P03') return true;
		if (error.code === '08006' || error.code === '08003' || error.code === '08000') return true;
	}

	const message = String(error.message ?? '').toLowerCase();
	return (
		message.includes('connection terminated unexpectedly') ||
		message.includes('connection ended unexpectedly') ||
		message.includes('connection terminated') ||
		message.includes('terminating connection') ||
		message.includes('client has encountered a connection error')
	);
}

function createResilientPgClient(connectionString) {
	let client = new Client({
		connectionString,
		keepAlive: true,
		keepAliveInitialDelayMillis: 10_000,
	});
	let connected = false;

	const attachErrorHandler = (targetClient) => {
		targetClient.on('error', (error) => {
			connected = false;
			console.warn(`warning: PostgreSQL connection error: ${error.message}`);
		});
	};

	attachErrorHandler(client);

	const connect = async () => {
		if (connected) return;
		await client.connect();
		connected = true;
	};

	const reconnect = async () => {
		try {
			await client.end();
		} catch {}
		client = new Client({
			connectionString,
			keepAlive: true,
			keepAliveInitialDelayMillis: 10_000,
		});
		attachErrorHandler(client);
		connected = false;
		await connect();
	};

	const query = async (text, params = []) => {
		const maxAttempts = 4;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await connect();
				return await client.query(text, params);
			} catch (error) {
				if (!isRetryablePgConnectionError(error) || attempt === maxAttempts) throw error;
				console.warn(
					`warning: PostgreSQL query failed (attempt ${attempt}/${maxAttempts}): ${error.message}`,
				);
				await sleep(800 * attempt);
				await reconnect();
			}
		}

		throw new Error('Unreachable PostgreSQL retry state');
	};

	const end = async () => {
		try {
			await client.end();
		} catch {}
		connected = false;
	};

	return { connect, query, end };
}

async function getSqliteTables(sqliteDb) {
	const rows = await sqliteAll(
		sqliteDb,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	return rows.map((r) => r.name);
}

async function getPostgresTables(pg) {
	const { rows } = await pg.query(
		`SELECT table_name
		 FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		 ORDER BY table_name`,
	);
	return rows.map((r) => r.table_name);
}

async function getPostgresColumns(pg, table) {
	const { rows } = await pg.query(
		`SELECT column_name, data_type, ordinal_position
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1
		 ORDER BY ordinal_position`,
		[table],
	);
	return rows;
}

async function getSqliteColumns(sqliteDb, table) {
	const pragmaSql = `PRAGMA table_info(${quoteIdent(table)})`;
	const rows = await sqliteAll(sqliteDb, pragmaSql);
	return rows.map((r) => r.name);
}

async function getForeignKeyDependencies(pg, tables) {
	if (tables.length === 0) return new Map();

	const { rows } = await pg.query(
		`SELECT tc.table_name AS child_table,
		        ccu.table_name AS parent_table
		 FROM information_schema.table_constraints AS tc
		 JOIN information_schema.key_column_usage AS kcu
		   ON tc.constraint_name = kcu.constraint_name
		  AND tc.table_schema = kcu.table_schema
		 JOIN information_schema.constraint_column_usage AS ccu
		   ON ccu.constraint_name = tc.constraint_name
		  AND ccu.table_schema = tc.table_schema
		 WHERE tc.constraint_type = 'FOREIGN KEY'
		   AND tc.table_schema = 'public'`,
	);

	const tableSet = new Set(tables);
	const deps = new Map(tables.map((t) => [t, new Set()]));

	for (const row of rows) {
		if (!tableSet.has(row.child_table) || !tableSet.has(row.parent_table)) continue;
		deps.get(row.child_table).add(row.parent_table);
	}

	return deps;
}

function sortTablesByDependencies(tables, deps) {
	const ordered = [];
	const remaining = new Set(tables);

	while (remaining.size > 0) {
		let progressed = false;

		for (const table of [...remaining].sort()) {
			const parents = deps.get(table) ?? new Set();
			const unresolvedParent = [...parents].some((p) => remaining.has(p));

			if (!unresolvedParent) {
				ordered.push(table);
				remaining.delete(table);
				progressed = true;
			}
		}

		if (!progressed) {
			for (const table of [...remaining].sort()) {
				ordered.push(table);
				remaining.delete(table);
			}
		}
	}

	return ordered;
}

async function truncateTargetTables(pg, tables) {
	if (tables.length === 0) return;
	const quoted = tables.map(quoteIdent).join(', ');
	await pg.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

async function resetSequences(pg) {
	const { rows } = await pg.query(
		`SELECT table_name, column_name,
		        pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
	);

	for (const row of rows) {
		if (!row.sequence_name) continue;
		const query = `
			SELECT setval(
				$1,
				COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${quoteIdent(row.table_name)}), 0) + 1,
				false
			)
		`;
		await pg.query(query, [row.sequence_name]);
	}
}

async function insertRowsWithFkRetry({
	pg,
	table,
	commonColumns,
	pgColumnMap,
	batchRows,
	skipFkErrors,
	onConflictDoNothing,
	skipOverflowErrors,
}) {
	const insertSql = buildInsertStatement(table, commonColumns, batchRows.length, { onConflictDoNothing });
	const batchValues = [];

	for (const row of batchRows) {
		for (const columnName of commonColumns) {
			const pgType = pgColumnMap.get(columnName)?.data_type;
			batchValues.push(coerceValue(row[columnName], pgType));
		}
	}

	try {
		await pg.query(insertSql, batchValues);
		return { inserted: batchRows.length, skipped: 0 };
	} catch (error) {
		const isFk = error?.code === '23503';
		const isOverflow = error?.code === '22001';
		if ((!skipFkErrors || !isFk) && (!skipOverflowErrors || !isOverflow)) throw error;
	}

	let pending = [...batchRows];
	let inserted = 0;

	while (pending.length > 0) {
		let progressed = 0;
		const nextPending = [];

		for (const row of pending) {
			const singleInsert = buildInsertStatement(table, commonColumns, 1, { onConflictDoNothing });
			const values = [];
			for (const columnName of commonColumns) {
				const pgType = pgColumnMap.get(columnName)?.data_type;
				values.push(coerceValue(row[columnName], pgType));
			}

			try {
				await pg.query(singleInsert, values);
				progressed += 1;
				inserted += 1;
			} catch (error) {
				if (error?.code === '23503' && skipFkErrors) {
					nextPending.push(row);
					continue;
				}
				if (error?.code === '22001' && skipOverflowErrors) {
					nextPending.push(row);
					continue;
				}
				throw error;
			}
		}

		if (progressed === 0) {
			return { inserted, skipped: nextPending.length };
		}

		pending = nextPending;
	}

	return { inserted, skipped: 0 };
}

async function migrateTable({
	sqliteDb,
	pg,
	table,
	batchSize,
	dryRun,
	skipFkErrors,
	onConflictDoNothing,
	skipSqliteErrors,
	skipOverflowErrors,
	excludeColumns,
}) {
	let sqliteColumns;
	let pgColumns;
	try {
		sqliteColumns = await getSqliteColumns(sqliteDb, table);
		pgColumns = await getPostgresColumns(pg, table);
	} catch (error) {
		if (skipSqliteErrors && String(error.message ?? '').includes('SQLITE_CORRUPT')) {
			console.log(`- ${table}: skipped (SQLite corruption while reading metadata)`);
			return;
		}
		throw error;
	}
	const pgColumnMap = new Map(pgColumns.map((c) => [c.column_name, c]));

	const commonColumns = pgColumns
		.map((c) => c.column_name)
		.filter((columnName) => sqliteColumns.includes(columnName));
	const filteredColumns = commonColumns.filter((columnName) => {
		const key = `${table}.${columnName}`;
		return !excludeColumns.has(key);
	});

	if (filteredColumns.length === 0) {
		console.log(`- ${table}: skipped (no matching columns)`);
		return;
	}

	let countRow;
	try {
		countRow = await sqliteGet(sqliteDb, `SELECT COUNT(*) as count FROM ${quoteIdent(table)}`);
	} catch (error) {
		if (skipSqliteErrors && String(error.message ?? '').includes('SQLITE_CORRUPT')) {
			console.log(`- ${table}: skipped (SQLite corruption while counting rows)`);
			return;
		}
		throw error;
	}
	const totalRows = Number(countRow?.count ?? 0);
	console.log(`- ${table}: ${totalRows} row(s), ${filteredColumns.length} column(s)`);

	if (dryRun || totalRows === 0) return;

	let offset = 0;
	let tableSkippedRows = 0;

	while (offset < totalRows) {
		const sql = `SELECT ${filteredColumns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`;
		let batchRows;
		try {
			batchRows = await sqliteAll(sqliteDb, sql, [batchSize, offset]);
		} catch (error) {
			if (skipSqliteErrors && String(error.message ?? '').includes('SQLITE_CORRUPT')) {
				console.log(`  warning: stopped ${table} at ${offset}/${totalRows} due to SQLite corruption`);
				break;
			}
			throw error;
		}
		if (batchRows.length === 0) break;

		const result = await insertRowsWithFkRetry({
			pg,
			table,
			commonColumns: filteredColumns,
			pgColumnMap,
			batchRows,
			skipFkErrors,
			onConflictDoNothing,
			skipOverflowErrors,
		});
		tableSkippedRows += result.skipped;

		offset += batchRows.length;
		const percent = totalRows === 0 ? 100 : Math.floor((offset / totalRows) * 100);
		console.log(`  progress: ${offset}/${totalRows} (${percent}%)`);
	}

	if (tableSkippedRows > 0) {
		console.log(`  warning: skipped ${tableSkippedRows} row(s) in ${table} due to FK violations`);
	}
}

async function ensureTargetLooksInitialized(pg) {
	const { rows } = await pg.query(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'migrations'
		) AS ok`,
	);

	if (!rows[0]?.ok) {
		throw new Error(
			'Target PostgreSQL DB does not look initialized for n8n (missing public.migrations table). Initialize it with n8n first.',
		);
	}
}

async function main() {
	const args = parseArgs(process.argv);
	const sqlitePath = path.resolve(args.sqlite);

	if (!fs.existsSync(sqlitePath)) {
		throw new Error(`SQLite file not found: ${sqlitePath}`);
	}

	console.log(`SQLite:   ${sqlitePath}`);
	console.log(`Postgres: ${args.postgres}`);
	if (args.dryRun) console.log('Mode:     dry-run');
	if (args.skipFkErrors) console.log('Mode:     skip FK violations');
	if (args.resume) console.log('Mode:     resume (no truncate + conflict skip)');
	if (args.skipSqliteErrors) console.log('Mode:     skip SQLite corruption errors');
	if (args.skipOverflowErrors) console.log('Mode:     skip varchar overflow rows');
	if (args.excludeColumns.size > 0) {
		console.log(`Mode:     excluding columns (${[...args.excludeColumns].join(', ')})`);
	}

	const sqliteDb = await openSqlite(sqlitePath);
	const pg = createResilientPgClient(args.postgres);

	try {
		await pg.connect();
		await ensureTargetLooksInitialized(pg);

		const sqliteTables = await getSqliteTables(sqliteDb);
		const postgresTables = await getPostgresTables(pg);
		const postgresTableSet = new Set(postgresTables);
		const sharedTables = sqliteTables
			.filter((t) => postgresTableSet.has(t))
			.filter((t) => args.onlyTables.size === 0 || args.onlyTables.has(t))
			.filter((t) => !args.skipTables.has(t));
		const skippedSourceOnly = sqliteTables.filter((t) => !postgresTableSet.has(t));
		const skippedByUser = sqliteTables.filter((t) => args.skipTables.has(t));

		const deps = await getForeignKeyDependencies(pg, sharedTables);
		const orderedTables = sortTablesByDependencies(sharedTables, deps);

		console.log(`\nFound ${sharedTables.length} shared table(s).`);
		if (skippedSourceOnly.length > 0) {
			console.log(`Skipping ${skippedSourceOnly.length} source-only table(s): ${skippedSourceOnly.join(', ')}`);
		}
		if (skippedByUser.length > 0) {
			console.log(`Skipping ${skippedByUser.length} user-selected table(s): ${skippedByUser.join(', ')}`);
		}

		if (!args.dryRun && !args.resume) {
			console.log('\nTruncating target tables...');
			await truncateTargetTables(pg, sharedTables);
		}

		console.log('\nMigrating tables in dependency order...');
		for (const table of orderedTables) {
			await migrateTable({
				sqliteDb,
				pg,
				table,
				batchSize: args.batchSize,
				dryRun: args.dryRun,
				skipFkErrors: args.skipFkErrors,
				onConflictDoNothing: args.resume,
				skipSqliteErrors: args.skipSqliteErrors,
				skipOverflowErrors: args.skipOverflowErrors,
				excludeColumns: args.excludeColumns,
			});
		}

		if (!args.dryRun) {
			console.log('\nResetting PostgreSQL sequences...');
			await resetSequences(pg);
		}

		console.log('\nDone.');
	} finally {
		await sqliteClose(sqliteDb);
		await pg.end();
	}
}

main().catch((error) => {
	console.error(`\nMigration failed: ${error.message}`);
	process.exit(1);
});
