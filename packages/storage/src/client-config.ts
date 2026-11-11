import type { S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * How to reach a bucket. AWS is reached by region; anything else by
 * `endpoint`: a Railway bucket in production (**D-118**), MinIO locally.
 */
export interface StorageConnection {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
  forcePathStyle: boolean;
}

/**
 * The S3 client settings, in one place for the app and for
 * `scripts/move-bucket.ts`, so the script proves a bucket works with exactly
 * the client the app will use.
 *
 * **Off AWS, a checksum is sent only when an operation requires one.** Since
 * SDK 3.729 the client attaches a CRC32 checksum to every upload it can,
 * presigned PUT URLs included. Not every S3-compatible service accepts that,
 * and a browser upload to a presigned URL carrying one fails with a signature
 * error that names nothing useful. AWS keeps the SDK's default.
 */
export function s3ClientConfig(connection: StorageConnection): S3ClientConfig {
  return {
    region: connection.region,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    forcePathStyle: connection.forcePathStyle,
    ...(connection.endpoint
      ? {
          endpoint: connection.endpoint,
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  };
}
