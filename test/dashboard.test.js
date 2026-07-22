import assert from 'node:assert/strict'
import { rankBehavior } from '../apps/web/src/dashboard.js'

assert.deepEqual(rankBehavior({ route: 2, pushState: 3, popstate: 4, click: 1 }), [['路由切换', 9], ['点击', 1]])

console.log('dashboard tests passed')
