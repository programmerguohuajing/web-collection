import test from 'node:test'
import assert from 'node:assert/strict'
import { createDsrRequest, listDsrRequests, getDsrRequest, submitDsrRequest, approveDsrRequest, cancelDsrRequest } from '../apps/api/src/services/dsr-service.js'

test('DSR 全流程功能验证：创建/修改草稿/提交/Admin自批', async (t) => {
  const adminAuth = { userId: 'usr_admin', role: 'admin', via: 'session', teamId: 'team_default' }

  // 1. 创建草稿
  const draft1 = await createDsrRequest({
    subjectType: 'user_id',
    subjectValue: 'test_user_001',
    requestType: 'access',
    exportFormat: 'csv'
  }, adminAuth)

  assert.ok(draft1.id.startsWith('dsr_'))
  assert.equal(draft1.status, 'draft')
  assert.equal(draft1.subjectValue, 'test_user_001')

  // 2. 步骤2修改模式：原地更新草稿（不产生重复垃圾工单）
  const draft2 = await createDsrRequest({
    draftId: draft1.id,
    subjectType: 'user_id',
    subjectValue: 'test_user_001',
    requestType: 'access',
    exportFormat: 'json'
  }, adminAuth)

  assert.equal(draft2.id, draft1.id)
  assert.equal(draft2.exportFormat, 'json')

  const listAfterUpdate = await listDsrRequests({}, adminAuth)
  const matchingDrafts = listAfterUpdate.items.filter(item => item.id === draft1.id)
  assert.equal(matchingDrafts.length, 1)

  // 3. 提交审批
  const submitted = await submitDsrRequest(draft1.id, adminAuth)
  assert.equal(submitted.status, 'pending_approval')

  // 4. Admin 自批放行（对齐 Admin/Owner 发起场景）
  const approved = await approveDsrRequest(draft1.id, { decision: 'approve' }, adminAuth)
  assert.equal(approved.status, 'approved')
  assert.equal(approved.approvedBy, 'usr_admin')

  // 5. 详情查询验证
  const detail = await getDsrRequest(draft1.id, adminAuth)
  assert.equal(detail.request.status, 'approved')
  assert.ok(detail.audit.length >= 3)
})
