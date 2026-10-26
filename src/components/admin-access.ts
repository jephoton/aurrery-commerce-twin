export interface AccessState { hosted: boolean; configured: boolean; authenticated: boolean; canReview: boolean }
export const canReviewAccess = (state: AccessState | null): boolean => state?.configured === true && state.canReview === true;
