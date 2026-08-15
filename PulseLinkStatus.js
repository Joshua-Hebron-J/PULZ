import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { syncPulseLinkRequest } from './pulseLinkApi';

const STORAGE_KEY = 'PulseLinkPendingRequests';

async function hashBloodType(value) {
  return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, (value || '').trim().toUpperCase());
}

async function getStoredRequests() {
  const json = await AsyncStorage.getItem(STORAGE_KEY);
  return json ? JSON.parse(json) : [];
}

async function setStoredRequests(requests) {
  return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
}

export async function enqueuePulseLinkRequest(request) {
  const queue = await getStoredRequests();
  const hashedBlood = await hashBloodType(request.bloodType);
  queue.push({
    id: `pulse_${Date.now()}`,
    createdAt: new Date().toISOString(),
    hospitalId: request.hospitalId,
    coordinates: request.coordinates,
    bloodType: request.bloodType,
    bloodHash: hashedBlood,
    rawNote: request.rawNote,
    status: 'pending',
  });
  await setStoredRequests(queue);
  return queue;
}

export default function PulseLinkStatus() {
  const [pending, setPending] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [netState, setNetState] = useState(null);

  const hasCellular = useMemo(() => {
    return netState?.type === 'cellular' && netState?.isConnected;
  }, [netState]);

  useEffect(() => {
    loadQueue();
    const unsubscribe = NetInfo.addEventListener((state) => {
      setNetState(state);
      if (state.isConnected && state.type === 'cellular') {
        syncPendingRequests();
      }
    });
    return unsubscribe;
  }, []);

  async function loadQueue() {
    const queue = await getStoredRequests();
    setPending(queue || []);
  }

  async function syncPendingRequests() {
    if (syncing) return;
    setSyncing(true);
    try {
      const queue = await getStoredRequests();
      if (!queue.length) return;

      const syncedQueue = await Promise.all(
        queue.map(async (item) => {
          if (item.status === 'synced') return item;
          try {
            await syncPulseLinkRequest({
              hospital_id: item.hospitalId,
              blood_type: item.bloodType,
              coordinates: item.coordinates,
              note: item.rawNote,
            });
            return { ...item, status: 'synced', syncedAt: new Date().toISOString() };
          } catch (error) {
            return { ...item, status: 'failed', error: error.message };
          }
        })
      );
      await setStoredRequests(syncedQueue);
      setPending(syncedQueue);
    } finally {
      setSyncing(false);
    }
  }

  const offlineCount = pending.filter((item) => item.status === 'pending').length;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PulseLink Status</Text>
      <Text style={styles.subtitle}>Offline queue tracks emergency requests until 2G/3G returns.</Text>
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Network:</Text>
        <Text style={styles.statusValue}>{netState?.type || 'unknown'}</Text>
      </View>
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Connected:</Text>
        <Text style={styles.statusValue}>{netState?.isConnected ? 'Yes' : 'No'}</Text>
      </View>
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Pending Requests:</Text>
        <Text style={styles.statusValue}>{offlineCount}</Text>
      </View>
      <TouchableOpacity style={styles.syncButton} onPress={syncPendingRequests} disabled={syncing || !netState?.isConnected}>
        {syncing ? <ActivityIndicator color="#fff" /> : <Text style={styles.syncText}>Sync Queue</Text>}
      </TouchableOpacity>
      <FlatList
        data={pending}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.requestCard}>
            <Text style={styles.requestTitle}>{item.hospitalId}</Text>
            <Text style={styles.requestMeta}>{item.bloodType} · {item.coordinates?.lat?.toFixed?.(3)}, {item.coordinates?.lng?.toFixed?.(3)}</Text>
            <Text style={styles.requestNote}>{item.rawNote}</Text>
            <Text style={[styles.requestStatus, item.status === 'synced' ? styles.synced : styles.failed]}>{item.status.toUpperCase()}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>No offline PulseLink requests queued.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#070a0c' },
  title: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 8 },
  subtitle: { color: '#9f8c8b', marginBottom: 16 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  statusLabel: { color: '#b0b0b0' },
  statusValue: { color: '#fff', fontWeight: '700' },
  syncButton: { marginVertical: 12, backgroundColor: '#00e3fd', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  syncText: { color: '#001f24', fontWeight: '700' },
  requestCard: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14, padding: 14, marginBottom: 12 },
  requestTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  requestMeta: { color: '#9f8c8b', marginVertical: 6 },
  requestNote: { color: '#e2e2e2', marginBottom: 8 },
  requestStatus: { textTransform: 'uppercase', fontSize: 12, fontWeight: '700' },
  synced: { color: '#43a047' },
  failed: { color: '#ff535b' },
  emptyText: { color: '#5b5b5b', marginTop: 20, textAlign: 'center' },
});