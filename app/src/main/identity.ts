export interface ApplicationIdentity {
  readonly productName: string;
  readonly appId: string;
  readonly userDataDirectoryName: string;
  readonly nsisGuid: string;
}

/**
 * Published Murmur installer and application identity. Gate 2 retains these
 * compatibility values while selecting the Eve user-data root separately.
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
