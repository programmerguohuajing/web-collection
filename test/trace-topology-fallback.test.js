import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTopologyFromDistributed } from '../apps/web/src/utils/trace-topology.js'

test('distributed fallback renders an event-only trace as one topology node', () => {
  const topology = buildTopologyFromDistributed({
    nodes: [{ id: 'event-1', name: 'error', service: 'frontend', kind: 'CLIENT', duration: 0, status: 'ERROR', hasError: true }],
    edges: []
  })

  assert.deepEqual(topology, {
    nodes: [{ id: 'service:frontend', label: 'error', type: 'frontend', value: 1, p95: 0, errors: 1 }],
    edges: []
  })
})

test('distributed fallback aggregates service nodes, calls, duration and errors', () => {
  const topology = buildTopologyFromDistributed({
    nodes: [
      { id: 'root', name: '/checkout', service: 'frontend', kind: 'CLIENT', duration: 5, status: 'OK' },
      { id: 'api-1', name: 'GET /orders', service: 'order-api', kind: 'SERVER', duration: 80, status: 'OK' },
      { id: 'api-2', name: 'GET /orders', service: 'order-api', kind: 'SERVER', duration: 120, status: 'ERROR', hasError: true },
      { id: 'db-1', name: 'SELECT orders', service: 'postgres-db', kind: 'DB', duration: 30, status: 'OK' }
    ],
    edges: [
      { source: 'root', target: 'api-1' },
      { source: 'root', target: 'api-2' },
      { source: 'api-2', target: 'db-1' }
    ]
  })

  assert.deepEqual(topology.nodes, [
    { id: 'service:frontend', label: '/checkout', type: 'frontend', value: 1, p95: 5, errors: 0 },
    { id: 'service:order-api', label: 'order-api', type: 'service', value: 2, p95: 120, errors: 1 },
    { id: 'service:postgres-db', label: 'postgres-db', type: 'database', value: 1, p95: 30, errors: 0 }
  ])
  assert.deepEqual(topology.edges, [
    { source: 'service:frontend', target: 'service:order-api', calls: 2, avgDuration: 100, errors: 1 },
    { source: 'service:order-api', target: 'service:postgres-db', calls: 1, avgDuration: 30, errors: 0 }
  ])
})
