import { Redirect, Stack } from 'expo-router';
import Head from 'expo-router/head';
import { DEMO_MODE } from '../lib/demo/mode';
import { DisplayPage } from '../lib/display-page';

// A second device's customer display: no session, never the till's, and none in the demo (Front desk ruling 2026-11-18).
export default function DisplayScreen() {
  if (DEMO_MODE) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Head><title>Customer display</title></Head>
      <DisplayPage />
    </>
  );
}
