export {
  sniff,
  trySniff,
  declaredTypeMatches,
  UnsupportedMediaError,
  SNIFF_PREFIX_BYTES,
  type SniffResult,
} from './sniff.js';

export { probeMedia, IMAGE_PROBE_BYTES, VIDEO_PROBE_BYTES, type MediaProbe } from './probe.js';

export {
  buildObjectKey,
  organizationPrefix,
  assertKeyBelongsTo,
  sanitiseFilename,
  type KeyParts,
} from './keys.js';

export {
  s3,
  bucket,
  resetS3,
  presignUpload,
  presignDownload,
  putObject,
  headObject,
  readRange,
  readObject,
  deleteObject,
  deleteObjects,
  type ObjectHead,
  type PresignUploadInput,
} from './s3.js';

export {
  convertImage,
  derivedImageKeys,
  ensureConvertedImage,
  getDerivedStorageKey,
  type ImageConversionOptions,
  type ConvertedImage,
} from './convert.js';

export { s3ClientConfig, type StorageConnection } from './client-config.js';

export {
  verifyUploadedObject,
  MediaRejected,
  type VerificationInput,
  type VerifiedMedia,
} from './verify.js';
