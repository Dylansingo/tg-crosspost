/**
 * Media staging (ME-1).
 *
 * The Media Engineer implements {@link Stager}. Offline runs should write
 * files under {@link LOCAL_STAGE_DIRECTORY}. R2 is used only when that
 * platform is enabled. The S3 client (`@aws-sdk/client-s3`) belongs in that
 * implementation. Ingestion and the demo do not import it.
 */
export const LOCAL_STAGE_DIRECTORY = './out';

export interface Stager {
  stage(buf: Buffer, name: string): Promise<string>;
}
