// One button. Deliberately nothing else — no email/password fallback, no
// "remember me" (the session is always remembered), no marketing copy.

import { useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect } from 'expo-router';

import { apiErrorMessage } from '@/api';
import { useAuth } from '@/auth';
import { Button, Card, ErrorNote, LoadingBlock, Screen } from '@/components';

export default function SignInScreen() {
  const { status, signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Boot may still be reading the keystore if this route was opened directly.
  if (status === 'restoring') {
    return (
      <Screen className="flex-1 items-center justify-center px-4">
        <LoadingBlock />
      </Screen>
    );
  }

  // Covers both "already signed in" and the moment `signIn()` succeeds.
  if (status === 'signed-in') {
    return <Redirect href="/(tabs)/now" />;
  }

  const handleSignIn = async () => {
    setError(null);
    setBusy(true);
    try {
      // A `'cancelled'` result is the user changing their mind. Nothing
      // happened, so nothing is reported.
      await signIn();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not sign in. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen className="flex-1 justify-center px-6 gap-4">
      <Card className="gap-2">
        <Text className="text-2xl font-semibold text-slate-100">Vibe Tracker</Text>
        <Text className="text-sm leading-relaxed text-slate-400">
          Track the block you are working in, and turn it into time entries.
        </Text>

        <View className="mt-6">
          <Button
            label="Continue with Google"
            onPress={handleSignIn}
            loading={busy}
            size="lg"
            testID="sign-in-google"
          />
        </View>
      </Card>

      {error ? <ErrorNote message={error} /> : null}
    </Screen>
  );
}
