import path from 'node:path';

export interface ApplicationIdentity {
  readonly productName: string;
  readonly appId: string;
  readonly userDataDirectoryName: string;
  readonly nsisGuid: string;
}

/**
 * Published Murmur identity. These values remain active during compatibility
 * scaffolding so installer, application, and user-data behavior do not change.
 */
export const MURMUR_IDENTITY = {
  productName: 'Murmur',
  appId: 'com.murmur.app',
  userDataDirectoryName: 'murmur',
  nsisGuid: '0204d005-75b3-5b31-b1f6-ef2831e2b204',
} as const satisfies ApplicationIdentity;

/**
 * Selected future display identity. It is descriptive only and is not active
 * until a later, separately approved cutover.
 */
export const EVE_PRODUCT_NAME = 'Eve' as const;
export const EVE_USER_DATA_DIRECTORY_NAME = 'Eve' as const;

export function resolveUserDataPath(
  appDataPath: string,
  directoryName: string
): string {
  return path.join(appDataPath, directoryName);
}
