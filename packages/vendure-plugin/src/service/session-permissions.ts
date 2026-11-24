import { RequestContext, idsAreEqual } from '@vendure/core';

/** #487: the caller's permissions on the active channel, from the same session data ctx.userHasPermissions checks; [] without a session or an entry for the channel. */
export function sessionChannelPermissions(ctx: RequestContext): string[] {
  try {
    const entry = ctx.session?.user?.channelPermissions?.find(item => idsAreEqual(item.id, ctx.channelId));
    return [...(entry?.permissions ?? [])];
  } catch {
    return [];
  }
}
