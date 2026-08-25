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

test('distributed fallback splits frontend fetch calls into per-endpoint api nodes with edges', () => {
  const topology = buildTopologyFromDistributed({
    nodes: [
      { id: 'root', name: 'page_load', service: 'frontend', kind: 'CLIENT', duration: 5, status: 'OK' },
      { id: 'f1', name: 'fetch', service: 'frontend', kind: 'CLIENT', duration: 80, status: 'OK', httpMethod: 'GET', httpUrl: 'https://api.example.com/orders?page=1' },
      { id: 'f2', name: 'fetch', service: 'frontend', kind: 'CLIENT', duration: 120, status: 'ERROR', hasError: true, httpMethod: 'GET', httpUrl: 'https://api.example.com/orders?page=2' },
      { id: 'f3', name: 'xhr', service: 'frontend', kind: 'CLIENT', duration: 30, status: 'OK', httpMethod: 'POST', httpUrl: '/api/pay' },
      { id: 'b1', name: 'GET /orders', service: 'order-api', kind: 'SERVER', duration: 60, status: 'OK' }
    ],
    edges: [
      { source: 'root', target: 'f1' },
      { source: 'root', target: 'f2' },
      { source: 'root', target: 'f3' },
      { source: 'f1', target: 'b1' }
    ]
  })

  assert.deepEqual(topology.nodes, [
    { id: 'service:frontend', label: 'page_load', type: 'frontend', value: 1, p95: 5, errors: 0 },
    { id: 'api:GET api.example.com/orders', label: 'GET api.example.com/orders', type: 'api', value: 2, p95: 120, errors: 1 },
    { id: 'api:POST /api/pay', label: 'POST /api/pay', type: 'api', value: 1, p95: 30, errors: 0 },
    { id: 'service:order-api', label: 'order-api', type: 'service', value: 1, p95: 60, errors: 0 }
  ])
  assert.deepEqual(topology.edges, [
    { source: 'service:frontend', target: 'api:GET api.example.com/orders', calls: 2, avgDuration: 100, errors: 1 },
    { source: 'service:frontend', target: 'api:POST /api/pay', calls: 1, avgDuration: 30, errors: 0 },
    { source: 'api:GET api.example.com/orders', target: 'service:order-api', calls: 1, avgDuration: 60, errors: 0 }
  ])
})
