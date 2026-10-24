/** Standalone local preview wiring; embedded viewers retain host-owned auth. */
export function localStoreAuthenticationHelp(sourceId) {
    if (!['easi-store-web', 'easi-store-dimse'].includes(sourceId)) return null;
    return {
        href: '/easi-store/sign-in', label: 'Sign in to EASI Store',
        message: 'Your EASI Store session is missing or has expired. Sign in using the link below, then return here and retry. Your search and selection have been kept.'
    };
}
