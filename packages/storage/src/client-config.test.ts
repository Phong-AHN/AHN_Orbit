import { describe, expect, it } from 'vitest';
import { s3ClientConfig } from './client-config';

const base = {
  region: 'auto',
  accessKeyId: 'id',
  secretAccessKey: 'secret',
  forcePathStyle: false,
};

describe('s3ClientConfig', () => {
  it('reaches AWS by region and leaves the SDK checksum defaults alone', () => {
    const config = s3ClientConfig({ ...base, region: 'eu-west-1' });
    expect(config.endpoint).toBeUndefined();
    expect(config.requestChecksumCalculation).toBeUndefined();
    expect(config.responseChecksumValidation).toBeUndefined();
  });

  /**
   * A presigned PUT that carries the SDK's default CRC32 checksum is refused
   * by some S3-compatible services, and the browser upload fails with a
   * signature error. Off AWS the checksum is sent only when required.
   */
  it('sends checksums only when required on an S3-compatible endpoint (D-118)', () => {
    const config = s3ClientConfig({ ...base, endpoint: 'https://t3.storageapi.dev' });
    expect(config.endpoint).toBe('https://t3.storageapi.dev');
    expect(config.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(config.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('passes path-style addressing through as given', () => {
    expect(s3ClientConfig({ ...base, forcePathStyle: true }).forcePathStyle).toBe(true);
  });
});
