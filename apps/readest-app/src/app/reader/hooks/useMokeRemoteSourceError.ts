import { useEffect, type RefObject } from 'react';
import { eventDispatcher } from '@/utils/event';
import {
  MOKE_REMOTE_SOURCE_FAILED,
  type MokeRemoteSourceFailure,
  type MokeRemoteSourceErrorDetail,
} from '@/services/mokeRemoteSource';

/** Keep late chapter errors on the same recovery path as import errors. */
export function useMokeRemoteSourceError(
  files: RefObject<string[] | null>,
  onError: (error: MokeRemoteSourceErrorDetail) => void,
): void {
  useEffect(() => {
    const failed = (event: CustomEvent<MokeRemoteSourceFailure>) => {
      if (files.current?.includes(event.detail.sourceUrl)) onError(event.detail.error);
    };
    eventDispatcher.on(MOKE_REMOTE_SOURCE_FAILED, failed);
    return () => eventDispatcher.off(MOKE_REMOTE_SOURCE_FAILED, failed);
  }, [files, onError]);
}
