import '@/utils/polyfill';
import Head from 'next/head';
import { useEffect, useState } from 'react';

import Reader from '@/app/reader/components/Reader';
import Providers from '@/components/Providers';
import { EnvProvider } from '@/context/EnvContext';
import { bootstrapMokeLaunchContext } from '@/helpers/mokeLaunchContext';
import { bootstrapMokeHostLaunch, hasMokeHostLookup } from '@/services/mokeHostLaunch';
import { bootstrapMokeLegacyProgress } from '@/services/mokeLegacyProgress';

import '../styles/globals.css';

if (typeof window !== 'undefined') {
  bootstrapMokeLaunchContext();
}

export default function MokeReaderPage() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    const launch = hasMokeHostLookup() ? bootstrapMokeHostLaunch() : bootstrapMokeLegacyProgress();
    void launch.then(
      () => {
        if (mounted) setReady(true);
      },
      () => {
        if (mounted) setFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  if (failed)
    return (
      <main role='alert'>This Reader launch is unavailable. Return to the host application.</main>
    );
  if (!ready) return <main aria-busy='true' />;
  return (
    <>
      <Head>
        <title>Readest</title>
        <meta
          name='viewport'
          content='minimum-scale=1, initial-scale=1, width=device-width, shrink-to-fit=no, user-scalable=no, viewport-fit=cover'
        />
      </Head>
      <EnvProvider>
        <Providers>
          <Reader />
        </Providers>
      </EnvProvider>
    </>
  );
}
