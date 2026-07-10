import { Container, type Constructable } from '@n8n/di';
import { mock } from 'vitest-mock-extended';

export const mockInstance = <T>(
	serviceClass: Constructable<T>,
	data?: Parameters<typeof mock<T>>[0],
) => {
	const instance = mock<T>(data as Parameters<typeof mock<T>>[0]);
	Container.set(serviceClass, instance as T);
	return instance;
};
