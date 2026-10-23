export const SESSION_ITEM_TYPE = 'application/x-easi-view-item';

/** Drag data contains only a random, one-use token. Image references stay inside
 * their owning viewer; another viewer or an external drop cannot resolve them. */
export class SessionDragRegistry {
    #active = null;
    begin(transfer, reference) {
        this.clear();
        if (!transfer || typeof transfer.setData !== 'function' || !reference ||
            typeof reference.seriesId !== 'string' || !reference.seriesId || reference.seriesId.length > 120 ||
            reference.instanceId != null && (typeof reference.instanceId !== 'string' || reference.instanceId.length > 120) ||
            ['stackIndex', 'frameIndex'].some(key => reference[key] != null && (!Number.isSafeInteger(reference[key]) || reference[key] < 0))) {
            throw new TypeError('Drag a series or image from this viewing session.');
        }
        const token = crypto.randomUUID();
        this.#active = { token, reference: { seriesId: reference.seriesId,
            ...(reference.instanceId ? { instanceId: reference.instanceId } : {}),
            stackIndex: reference.stackIndex ?? 0, frameIndex: reference.frameIndex ?? 0 } };
        transfer.clearData?.(); transfer.setData(SESSION_ITEM_TYPE, token); transfer.effectAllowed = 'copy';
        return token;
    }
    accepts(transfer) { return Boolean(this.#active && Array.from(transfer?.types ?? []).includes(SESSION_ITEM_TYPE)); }
    consume(transfer) {
        if (!this.accepts(transfer) || transfer.getData?.(SESSION_ITEM_TYPE) !== this.#active.token) return null;
        const reference = { ...this.#active.reference }; this.clear(); return reference;
    }
    clear() { this.#active = null; }
}
