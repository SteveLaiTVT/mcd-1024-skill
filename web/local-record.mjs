// Extension-only local records; each read/modify/write holds an origin-wide lock.
export function createLocalRecord({ key, normalize, extension = false, area = globalThis.chrome?.storage?.local, changes = globalThis.chrome?.storage?.onChanged, locks = globalThis.navigator?.locks } = {}) {
  const available = Boolean(extension && area?.get && area?.set && area?.remove && area?.setAccessLevel);
  let tail = Promise.resolve(), restricted = false;
  function queue(operation) {
    const work = async () => {
      if (!available) return null;
      if (!restricted) { await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); restricted = true; }
      return operation();
    };
    const result = tail.then(() => locks?.request ? locks.request(key, work) : work());
    tail = result.catch(() => {}); return result;
  }
  const read = async () => normalize((await area.get(key))[key]);
  const write = async (value) => {
    const record = normalize(value);
    if (!record) throw new Error('Invalid local record');
    await area.set({ [key]: record }); return record;
  };
  return {
    available,
    read: () => queue(read),
    save: (value, { matches } = {}) => queue(async () => {
      if (matches && !matches(await read())) throw new Error('Local record changed');
      return write(value);
    }),
    update: (change) => queue(async () => write(change(await read()))),
    clear: () => queue(() => area.remove(key)),
    subscribe(listener) {
      if (!available || !changes?.addListener) return () => {};
      const changed = (values, namespace) => {
        if (namespace === 'local' && Object.hasOwn(values, key)) listener(normalize(values[key].newValue));
      };
      changes.addListener(changed); return () => changes.removeListener(changed);
    },
  };
}
