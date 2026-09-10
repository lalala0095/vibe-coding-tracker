// The entry route. It renders nothing of its own — it decides where you land.
//
// The `restoring` branch is the point of the file: reading the keystore is
// async, so without it a signed-in user sees the sign-in screen for a frame
// before being bounced off it.

import { Redirect } from 'expo-router';

import { LoadingBlock, Screen } from '@/components';
import { useAuth } from '@/auth';

export default function Index() {
  const { status } = useAuth();

  if (status === 'restoring') {
    return (
      <Screen className="flex-1 items-center justify-center px-4">
        <LoadingBlock />
      </Screen>
    );
  }

  return <Redirect href={status === 'signed-in' ? '/(tabs)/now' : '/sign-in'} />;
}
