/**
 * URLs returned by {@link Stager.stage}. Publishers use these and do not
 * read the local directory or the bucket themselves.
 *
 * `tiktok` is the 9:16 story render. Photo posts reuse that file.
 */
export interface StagedMedia {
  feed: string;
  story: string;
  tiktok: string;
}

export interface Stager {
  stage(buf: Buffer, name: string): Promise<StagedMedia>;
}
