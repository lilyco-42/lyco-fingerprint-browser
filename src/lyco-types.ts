/** Safe account metadata shared with the renderer (no secrets, no subscription token). */
export interface BillingAccount {
  username: string;
  pointsBalance: number;
  proxyActive: boolean;
  proxyExpiresAt: string | null;
}
export interface BillingPlan {
  code: string;
  name: string;
  pointsPrice: number;
  durationDays: number;
}
