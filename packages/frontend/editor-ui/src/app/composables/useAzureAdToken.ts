import type { RouteLocationNormalizedLoaded } from 'vue-router';

const CANDIDATE_KEYS = ['azureToken', 'azureAdToken', 'azure_token', 'azureadToken'] as const;
const PROVIDER_HINTS = ['azure', 'azuread', 'azure-ad', 'microsoft'];

export function getAzureAdTokenFromQuery(route: RouteLocationNormalizedLoaded): string | undefined {
	for (const key of CANDIDATE_KEYS) {
		const value = route.query?.[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}

	const token = route.query?.token;
	if (typeof token === 'string' && token.trim()) {
		const provider = route.query?.provider;
		if (typeof provider === 'string' && PROVIDER_HINTS.includes(provider.toLowerCase())) {
			return token;
		}

		const isAzureFlag =
			route.query?.azure === '1' ||
			route.query?.azure === 'true' ||
			route.query?.azureAd === '1' ||
			route.query?.azureAd === 'true';

		if (isAzureFlag) {
			return token;
		}
	}

	return undefined;
}
