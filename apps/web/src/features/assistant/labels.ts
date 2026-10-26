/**
 * What each escalation category means, in words a colleague reads at a glance
 * (**D-108**). Kept apart from `@orbit/ai` so the browser bundle does not pull
 * in the prompt code to show a label.
 */
const CATEGORY_LABELS: Record<string, string> = {
  HUMAN_REQUESTED: 'Asked for a person',
  COMPLAINT: 'A complaint',
  REFUND_OR_PAYMENT: 'Refund or payment',
  LEGAL: 'A legal matter',
  SAFETY: 'Safety — answer quickly',
  ACCOUNT_OR_ORDER: 'About an order or account',
  SENSITIVE_DATA: 'Personal or sensitive details',
  NOT_IN_DOCUMENTS: 'Not covered by the documents',
  UNSAFE_ANSWER: 'The draft failed a safety check',
  MODEL_UNAVAILABLE: 'The assistant was unavailable',
  CUSTOM_TERM: 'Uses a phrase the brand hands over',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? 'Needs a person';
}
