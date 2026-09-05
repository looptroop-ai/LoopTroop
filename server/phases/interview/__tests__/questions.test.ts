import { describe, expect, it } from 'vitest'
import { parseInterviewQuestions } from '../questions'

describe.concurrent('parseInterviewQuestions', () => {
  it('parses wrapped question YAML for interview log previews', () => {
    const questions = parseInterviewQuestions([
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: Structure',
      '    question: "Which users should be supported first?"',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What problem are we solving?',
      },
      {
        id: 'Q02',
        phase: 'Structure',
        question: 'Which users should be supported first?',
      },
    ])
  })

  it('accepts top-level arrays when explicitly allowed', () => {
    const questions = parseInterviewQuestions([
      '- id: Q01',
      '  phase: foundation',
      '  question: "What should happen first?"',
    ].join('\n'), { allowTopLevelArray: true })

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What should happen first?',
      },
    ])
  })

  it('normalizes prompt/category aliases and ignores extra wrapper fields', () => {
    const questions = parseInterviewQuestions([
      'metadata:',
      '  model: big-pickle',
      'questions:',
      '  - id: Q01',
      '    category: Foundation',
      '    prompt: "What problem are we solving?"',
      '    rationale: "Need the core objective first."',
      '  - id: Q02',
      '    category: Structure',
      '    prompt: "Which user flows matter most?"',
      '    notes: "Optional internal note."',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What problem are we solving?',
      },
      {
        id: 'Q02',
        phase: 'Structure',
        question: 'Which user flows matter most?',
      },
    ])
  })

  it('extracts the YAML payload when models wrap it in prose and fences', () => {
    const questions = parseInterviewQuestions([
      'Here is the proposed interview draft.',
      '',
      '```yaml',
      'questions:',
      '  - id: Q01',
      '    category: Foundation',
      '    prompt: "What problem are we solving?"',
      '```',
      '',
      'Let me know if you want refinements.',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What problem are we solving?',
      },
    ])
  })

  it('extracts fenced big-pickle drafts when they are wrapped in transcript headers', () => {
    const questions = parseInterviewQuestions([
      '[assistant] [2026-03-11T11:36:54.291Z] ```yaml',
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What does improve mean to you specifically?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "Which GitOps components need security hardening?"',
      '```',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What does improve mean to you specifically?',
      },
      {
        id: 'Q02',
        phase: 'Structure',
        question: 'Which GitOps components need security hardening?',
      },
    ])
  })

  it('accepts alternate question wrapper headers and missing ids', () => {
    const questions = parseInterviewQuestions([
      'interview_questions:',
      '  - category: foundation',
      '    prompt: "What is the primary goal?"',
      '  - section: assembly',
      '    text: "How will we validate the rollout?"',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What is the primary goal?',
      },
      {
        id: 'Q02',
        phase: 'Assembly',
        question: 'How will we validate the rollout?',
      },
    ])
  })

  it('parses YAML with mixed 3-space/4-space indentation for properties', () => {
    const questions = parseInterviewQuestions([
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '   phase: Structure',
      '   question: "Which users should be supported first?"',
      '  - id: Q03',
      '     phase: Assembly',
      '     question: "How will success be verified?"',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q01',
        phase: 'Foundation',
        question: 'What problem are we solving?',
      },
      {
        id: 'Q02',
        phase: 'Structure',
        question: 'Which users should be supported first?',
      },
      {
        id: 'Q03',
        phase: 'Assembly',
        question: 'How will success be verified?',
      },
    ])
  })

  it('repairs malformed yaml-like question blocks instead of dropping the whole draft', () => {
    const questions = parseInterviewQuestions([
      '[MODEL] ```yaml',
      'questions:',
      '  - id: Q20',
      '    phase: structure',
      '    question: "Do you want to optimize the startup and shutdown scripts for the cluster?"',
      '  - id: Q21',
      '    phase: structure',
      '    question: "Should resource requests/limits be tuned for better cluster id: Q22',
      '    phase: efficiency?"',
      '  - assembly',
      '    question: "For Ansible playbook optimization, should we implement parallel execution, caching, or skip unchanged tasks?"',
      '  - id: Q23',
      '    phase: assembly',
      '    question: "What is the acceptable trade-off between optimization speed and playbook idempotency/reliability?"',
      '```',
      '[SYS] Step finished: stop',
    ].join('\n'))

    expect(questions).toEqual([
      {
        id: 'Q20',
        phase: 'Structure',
        question: 'Do you want to optimize the startup and shutdown scripts for the cluster?',
      },
      {
        id: 'Q21',
        phase: 'Structure',
        question: 'Should resource requests/limits be tuned for better cluster efficiency?',
      },
      {
        id: 'Q22',
        phase: 'Assembly',
        question: 'For Ansible playbook optimization, should we implement parallel execution, caching, or skip unchanged tasks?',
      },
      {
        id: 'Q23',
        phase: 'Assembly',
        question: 'What is the acceptable trade-off between optimization speed and playbook idempotency/reliability?',
      },
    ])
  })
})

