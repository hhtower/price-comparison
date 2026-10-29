export interface FingerprintChallenge { id: string; expected_count: number; prompt: string; }
export function generateChallenges(count?: number): FingerprintChallenge[];
