-- Frame rate, read from the file's own sample table at verification time.
--
-- Both nullable and both absent for every asset already stored: nothing
-- backfills them, because the bytes would have to be re-read and an old asset
-- that already published is not a question anyone is asking. A null reads as
-- "not known", and the validator skips a check it has no number for rather than
-- refusing the post.
--
-- `peakFrameRate` is the one that matters. A phone records variable frame rate
-- by default, so the average sits near the nominal 30 while the instantaneous
-- rate spikes far past any platform ceiling — which is what TikTok's checker
-- sees when it refuses a file with `frame_rate_check_failed`.
ALTER TABLE "MediaAsset" ADD COLUMN "frameRate" DOUBLE PRECISION;
ALTER TABLE "MediaAsset" ADD COLUMN "peakFrameRate" DOUBLE PRECISION;
