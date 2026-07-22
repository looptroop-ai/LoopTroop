export const importDraftView = () => import('@/components/workspace/DraftView').then(m => ({ default: m.DraftView }))
export const importCouncilView = () => import('@/components/workspace/CouncilView').then(m => ({ default: m.CouncilView }))
export const importInterviewQAView = () => import('@/components/workspace/InterviewQAView').then(m => ({ default: m.InterviewQAView }))
export const importApprovalView = () => import('@/components/workspace/ApprovalView').then(m => ({ default: m.ApprovalView }))
export const importCodingView = () => import('@/components/workspace/CodingView').then(m => ({ default: m.CodingView }))
export const importErrorView = () => import('@/components/workspace/ErrorView').then(m => ({ default: m.ErrorView }))
export const importCanceledView = () => import('@/components/workspace/CanceledView').then(m => ({ default: m.CanceledView }))
export const importPhaseReviewView = () => import('@/components/workspace/PhaseReviewView').then(m => ({ default: m.PhaseReviewView }))

export function preloadWorkspaceForView(uiView: string | undefined): Promise<unknown> {
  switch (uiView) {
    case 'draft': return importDraftView()
    case 'interview_qa': return importInterviewQAView()
    case 'approval': return importApprovalView()
    case 'coding':
    case 'done': return importCodingView()
    case 'manual_qa': return import('@/components/workspace/ManualQAView')
    case 'error': return importErrorView()
    case 'canceled': return importCanceledView()
    case 'council':
    default: return importCouncilView()
  }
}
