import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'VendurePOS' }} />
      <Text style={styles.title}>VendurePOS</Text>
      <Text style={styles.subtitle}>Point of sale for Vendure</Text>
      <Text style={styles.note}>Pre-MVP: not connected to a store yet.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 8,
  },
  note: {
    fontSize: 14,
    color: '#666',
    marginTop: 24,
  },
});
