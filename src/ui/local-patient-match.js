const field = value => typeof value === 'string' ? value.trim() : '';

function localSource(patient) {
    if (!patient || patient.synthetic) return null;
    const kinds = [patient.kind, patient.source?.kind, patient.provenance?.kind].filter(value => value != null);
    if (!kinds.length || kinds.some(kind => kind !== 'local')) return null;
    return patient.sourceId ?? patient.source?.id ?? patient.provenance?.sourceId ?? null;
}

export function canReviewLocalPatients(from, to) {
    const source = localSource(from);
    return Boolean(from?.id && to?.id && from.id !== to.id && source && source === localSource(to));
}

function fullName(value) {
    const groups = field(value).normalize('NFC').split('=').map(group => {
        const components = group.split('^').map(component => component.trim());
        while (components.at(-1) === '') components.pop();
        return components.join('^');
    });
    while (groups.at(-1) === '') groups.pop();
    return groups.join('=');
}

function birthDate(value) {
    const date = field(value);
    if (!/^\d{8}$/u.test(date) || Number(date.slice(0, 4)) < 1) return '';
    const year = Number(date.slice(0, 4)), month = Number(date.slice(4, 6)), day = Number(date.slice(6));
    const parsed = new Date(0); parsed.setUTCFullYear(year, month - 1, day);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? date : '';
}

/** A review suggestion only. Source records are never combined automatically. */
export function possibleLocalPatientMatch(from, to) {
    if (!canReviewLocalPatients(from, to)) return false;
    const id = field(from.patientId), name = fullName(from.patientName), date = birthDate(from.patientBirthDate);
    const fromIssuer = field(from.issuerOfPatientId), toIssuer = field(to.issuerOfPatientId);
    return Boolean(id && name && date && id === field(to.patientId) && name === fullName(to.patientName) &&
        date === birthDate(to.patientBirthDate) && (!fromIssuer || !toIssuer || fromIssuer === toIssuer));
}
