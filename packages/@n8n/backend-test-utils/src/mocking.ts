import { Container, type Constructable } from '@n8n/di';
import { mock } from 'jest-mock-extended';
import type { DeepPartial } from 'ts-essentials';

export const mockInstance = <T>(
	serviceClass: Constructable<T>,
	data: DeepPartial<T> | undefined = undefined,
) => {
	const instance = mock<T>(data as Parameters<typeof mock<T>>[0]);
	Container.set(serviceClass, instance as T);
	return instance;
};
