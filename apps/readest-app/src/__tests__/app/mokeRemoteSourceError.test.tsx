import { useRef, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useMokeRemoteSourceError } from '@/app/reader/hooks/useMokeRemoteSourceError';
import { MOKE_REMOTE_SOURCE_FAILED } from '@/services/mokeRemoteSource';
import { eventDispatcher } from '@/utils/event';

afterEach(cleanup);

const SOURCE = 'https://books.example/api/book/42.epub';
const failure = {
  sourceUrl: SOURCE,
  error: { code: 'online.network', operation: 'online.open', retryable: true },
};

function Reader() {
  const files = useRef([SOURCE]);
  const [error, setError] = useState<unknown>(null);
  useMokeRemoteSourceError(files, setError);
  return <div>{error ? 'Retry / Download' : 'Loading'}</div>;
}

it('replaces loading on a terminal chapter failure and ignores other sources', async () => {
  render(<Reader />);
  await act(() => eventDispatcher.dispatch(MOKE_REMOTE_SOURCE_FAILED, {
    ...failure, sourceUrl: 'https://other.example/api/book/42.epub',
  }));
  expect(screen.queryByText('Loading')).not.toBeNull();
  await act(() => eventDispatcher.dispatch(MOKE_REMOTE_SOURCE_FAILED, failure));
  expect(screen.queryByText('Loading')).toBeNull();
  expect(screen.queryByText('Retry / Download')).not.toBeNull();
});

it('unsubscribes when the reader is unmounted', async () => {
  const { unmount } = render(<Reader />);
  unmount();
  await act(() => eventDispatcher.dispatch(MOKE_REMOTE_SOURCE_FAILED, failure));
  render(<Reader />);
  expect(screen.queryByText('Loading')).not.toBeNull();
});
