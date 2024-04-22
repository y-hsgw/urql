import { stringifyVariables } from '@urql/core';

import type {
  Link,
  EntityField,
  FieldInfo,
  StorageAdapter,
  SerializedEntries,
  Dependencies,
  OperationType,
  DataField,
  Data,
} from '../types';

import {
  serializeKeys,
  deserializeKeyInfo,
  fieldInfoOfKey,
  joinKeys,
} from './keys';

import { invariant, currentDebugStack } from '../helpers/help';

type Dict<T> = Record<string, T>;
type KeyMap<T> = Map<string, T>;
type OperationMap<T> = Map<number, T>;

interface NodeMap<T> {
  optimistic: OperationMap<KeyMap<Dict<T | undefined>>>;
  base: KeyMap<Dict<T>>;
}

export interface InMemoryData {
  /** Flag for whether the data is waiting for hydration */
  hydrating: boolean;
  /** Flag for whether deferred tasks have been scheduled yet */
  defer: boolean;
  /** A list of entities that have been flagged for gargabe collection since no references to them are left */
  gc: Set<string>;
  /** A list of entity+field keys that will be persisted */
  persist: Set<string>;
  /** The API's "Query" typename which is needed to filter dependencies */
  queryRootKey: string;
  /** Number of references to each entity (except "Query") */
  refCount: KeyMap<number>;
  /** A map of entity fields (key-value entries per entity) */
  records: NodeMap<EntityField>;
  /** A map of entity links which are connections from one entity to another (key-value entries per entity) */
  links: NodeMap<Link>;
  /** A map of typename to a list of entity-keys belonging to said type */
  types: Map<string, Set<string>>;
  /** A set of Query operation keys that are in-flight and deferred/streamed */
  deferredKeys: Set<number>;
  /** A set of Query operation keys that are in-flight and awaiting a result */
  commutativeKeys: Set<number>;
  /** A set of Query operation keys that have been written to */
  dirtyKeys: Set<number>;
  /** The order of optimistic layers */
  optimisticOrder: number[];
  /** This may be a persistence adapter that will receive changes in a batch */
  storage: StorageAdapter | null;
  /** A map of all the types we have encountered that did not map directly to a concrete type */
  abstractToConcreteMap: Map<string, Set<string>>;
}

let currentOwnership: null | WeakSet<any> = null;
let currentDataMapping: null | WeakMap<any, any> = null;
let currentData: null | InMemoryData = null;
let currentOptimisticKey: null | number = null;
export let currentOperation: null | OperationType = null;
export let currentDependencies: null | Dependencies = null;
export let currentForeignData = false;
export let currentOptimistic = false;

export function makeData(data: DataField | void, isArray?: false): Data;
export function makeData(data: DataField | void, isArray: true): DataField[];

/** Creates a new data object unless it's been created in this data run */
export function makeData(data?: DataField | void, isArray?: boolean) {
  let newData: Data | Data[] | undefined;
  if (data) {
    if (currentOwnership!.has(data)) return data;
    newData = currentDataMapping!.get(data) as any;
  }

  if (newData == null) {
    newData = (isArray ? [] : {}) as any;
  }

  if (data) {
    currentDataMapping!.set(data, newData);
  }

  currentOwnership!.add(newData);
  return newData;
}

export const ownsData = (data?: Data): boolean =>
  !!data && currentOwnership!.has(data);

/** Before reading or writing the global state needs to be initialised */
export const initDataState = (
  operationType: OperationType,
  data: InMemoryData,
  layerKey?: number | null,
  isOptimistic?: boolean,
  isForeignData?: boolean
) => {
  currentOwnership = new WeakSet();
  currentDataMapping = new WeakMap();
  currentOperation = operationType;
  currentData = data;
  currentDependencies = new Set();
  currentOptimistic = !!isOptimistic;
  currentForeignData = !!isForeignData;
  if (process.env.NODE_ENV !== 'production') {
    currentDebugStack.length = 0;
  }

  if (!layerKey) {
    currentOptimisticKey = null;
  } else if (currentOperation === 'read') {
    // We don't create new layers for read operations and instead simply
    // apply the currently available layer, if any
    currentOptimisticKey = layerKey;
  } else if (
    isOptimistic ||
    data.hydrating ||
    data.optimisticOrder.length > 1
  ) {
    // If this operation isn't optimistic and we see it for the first time,
    // then it must've been optimistic in the past, so we can proactively
    // clear the optimistic data before writing
    if (!isOptimistic && !data.commutativeKeys.has(layerKey)) {
      reserveLayer(data, layerKey);
    } else if (isOptimistic) {
      if (
        data.optimisticOrder.indexOf(layerKey) !== -1 &&
        !data.commutativeKeys.has(layerKey)
      ) {
        data.optimisticOrder.splice(data.optimisticOrder.indexOf(layerKey), 1);
      }
      // NOTE: This optimally shouldn't happen as it implies that an optimistic
      // write is being performed after a concrete write.
      data.commutativeKeys.delete(layerKey);
    }

    // An optimistic update of a mutation may force an optimistic layer,
    // or this Query update may be applied optimistically since it's part
    // of a commutative chain
    currentOptimisticKey = layerKey;
    createLayer(data, layerKey);
  } else {
    // Otherwise we don't create an optimistic layer and clear the
    // operation's one if it already exists
    // We also do this when only one layer exists to avoid having to squash
    // any layers at the end of writing this layer
    currentOptimisticKey = null;
    deleteLayer(data, layerKey);
  }
};

/** Reset the data state after read/write is complete */
export const clearDataState = () => {
  // NOTE: This is only called to check for the invariant to pass
  if (process.env.NODE_ENV !== 'production') {
    getCurrentDependencies();
  }

  const data = currentData!;
  const layerKey = currentOptimisticKey;
  currentOptimistic = false;
  currentOptimisticKey = null;

  // Determine whether the current operation has been a commutative layer
  if (
    !data.hydrating &&
    layerKey &&
    data.optimisticOrder.indexOf(layerKey) > -1
  ) {
    // Squash all layers in reverse order (low priority upwards) that have
    // been written already
    let i = data.optimisticOrder.length;
    while (
      --i >= 0 &&
      data.dirtyKeys.has(data.optimisticOrder[i]) &&
      data.commutativeKeys.has(data.optimisticOrder[i])
    )
      squashLayer(data.optimisticOrder[i]);
  }

  currentOwnership = null;
  currentDataMapping = null;
  currentOperation = null;
  currentData = null;
  currentDependencies = null;
  if (process.env.NODE_ENV !== 'production') {
    currentDebugStack.length = 0;
  }

  if (process.env.NODE_ENV !== 'test') {
    // Schedule deferred tasks if we haven't already, and if either a persist or GC run
    // are likely to be needed
    if (!data.defer && (data.storage || !data.optimisticOrder.length)) {
      data.defer = true;
      setTimeout(() => {
        initDataState('read', data, null);
        gc();
        persistData();
        clearDataState();
        data.defer = false;
      });
    }
  }
};

/** Initialises then resets the data state, which may squash this layer if necessary */
export const noopDataState = (
  data: InMemoryData,
  layerKey: number | null,
  isOptimistic?: boolean
) => {
  if (layerKey && !isOptimistic) data.deferredKeys.delete(layerKey);
  initDataState('write', data, layerKey, isOptimistic);
  clearDataState();
};

/** As we're writing, we keep around all the records and links we've read or have written to */
export const getCurrentDependencies = (): Dependencies => {
  invariant(
    currentDependencies !== null,
    'Invalid Cache call: The cache may only be accessed or mutated during' +
      'operations like write or query, or as part of its resolvers, updaters, ' +
      'or optimistic configs.',
    2
  );

  return currentDependencies;
};

const DEFAULT_EMPTY_SET = new Set<string>();
export const make = (queryRootKey: string): InMemoryData => ({
  hydrating: false,
  defer: false,
  gc: new Set(),
  types: new Map(),
  persist: new Set(),
  queryRootKey,
  refCount: new Map(),
  links: {
    optimistic: new Map(),
    base: new Map(),
  },
  abstractToConcreteMap: new Map(),
  records: {
    optimistic: new Map(),
    base: new Map(),
  },
  deferredKeys: new Set(),
  commutativeKeys: new Set(),
  dirtyKeys: new Set(),
  optimisticOrder: [],
  storage: null,
});

/** Adds a node value to a NodeMap (taking optimistic values into account */
const setNode = <T>(
  map: NodeMap<T>,
  entityKey: string,
  fieldKey: string,
  value: T
) => {
  if (process.env.NODE_ENV !== 'production') {
    invariant(
      currentOperation !== 'read',
      'Invalid Cache write: You may not write to the cache during cache reads. ' +
        ' Accesses to `cache.writeFragment`, `cache.updateQuery`, and `cache.link` may ' +
        ' not be made inside `resolvers` for instance.',
      27
    );
  }

  // Optimistic values are written to a map in the optimistic dict
  // All other values are written to the base map
  const keymap: KeyMap<Dict<T | undefined>> = currentOptimisticKey
    ? map.optimistic.get(currentOptimisticKey)!
    : map.base;

  // On the map itself we get or create the entity as a dict
  let entity = keymap.get(entityKey) as Dict<T | undefined>;
  if (entity === undefined) {
    keymap.set(entityKey, (entity = Object.create(null)));
  }

  // If we're setting undefined we delete the node's entry
  // On optimistic layers we actually set undefined so it can
  // override the base value
  if (value === undefined && !currentOptimisticKey) {
    delete entity[fieldKey];
  } else {
    entity[fieldKey] = value;
  }
};

/** Gets a node value from a NodeMap (taking optimistic values into account */
const getNode = <T>(
  map: NodeMap<T>,
  entityKey: string,
  fieldKey: string
): T | undefined => {
  let node: Dict<T | undefined> | undefined;
  // A read may be initialised to skip layers until its own, which is useful for
  // reading back written data. It won't skip over optimistic layers however
  let skip =
    !currentOptimistic &&
    currentOperation === 'read' &&
    currentOptimisticKey &&
    currentData!.commutativeKeys.has(currentOptimisticKey);
  // This first iterates over optimistic layers (in order)
  for (let i = 0, l = currentData!.optimisticOrder.length; i < l; i++) {
    const layerKey = currentData!.optimisticOrder[i];
    const optimistic = map.optimistic.get(layerKey);
    // If we're reading starting from a specific layer, we skip until a match
    skip = skip && layerKey !== currentOptimisticKey;
    // If the node and node value exists it is returned, including undefined
    if (
      optimistic &&
      (!skip || !currentData!.commutativeKeys.has(layerKey)) &&
      (!currentOptimistic ||
        currentOperation === 'write' ||
        currentData!.commutativeKeys.has(layerKey)) &&
      (node = optimistic.get(entityKey)) !== undefined &&
      fieldKey in node
    ) {
      return node[fieldKey];
    }
  }

  // Otherwise we read the non-optimistic base value
  node = map.base.get(entityKey);
  return node !== undefined ? node[fieldKey] : undefined;
};

export function getRefCount(entityKey: string): number {
  return currentData!.refCount.get(entityKey) || 0;
}

/** Adjusts the reference count of an entity on a refCount dict by "by" and updates the gc */
const updateRCForEntity = (entityKey: string, by: number): void => {
  // Retrieve the reference count and adjust it by "by"
  const count = getRefCount(entityKey);
  const newCount = count + by > 0 ? count + by : 0;
  currentData!.refCount.set(entityKey, newCount);
  // Add it to the garbage collection batch if it needs to be deleted or remove it
  // from the batch if it needs to be kept
  if (!newCount) currentData!.gc.add(entityKey);
  else if (!count && newCount) currentData!.gc.delete(entityKey);
};

/** Adjusts the reference counts of all entities of a link on a refCount dict by "by" and updates the gc */
const updateRCForLink = (link: Link | undefined, by: number): void => {
  if (Array.isArray(link)) {
    for (let i = 0, l = link.length; i < l; i++) updateRCForLink(link[i], by);
  } else if (typeof link === 'string') {
    updateRCForEntity(link, by);
  }
};

/** Writes all parsed FieldInfo objects of a given node dict to a given array if it hasn't been seen */
const extractNodeFields = <T>(
  fieldInfos: FieldInfo[],
  seenFieldKeys: Set<string>,
  node: Dict<T> | undefined
): void => {
  if (node !== undefined) {
    for (const fieldKey in node) {
      if (!seenFieldKeys.has(fieldKey)) {
        // If the node hasn't been seen the serialized fieldKey is turnt back into
        // a rich FieldInfo object that also contains the field's name and arguments
        fieldInfos.push(fieldInfoOfKey(fieldKey));
        seenFieldKeys.add(fieldKey);
      }
    }
  }
};

/** Writes all parsed FieldInfo objects of all nodes in a NodeMap to a given array */
const extractNodeMapFields = <T>(
  fieldInfos: FieldInfo[],
  seenFieldKeys: Set<string>,
  entityKey: string,
  map: NodeMap<T>
) => {
  // Extracts FieldInfo for the entity in the base map
  extractNodeFields(fieldInfos, seenFieldKeys, map.base.get(entityKey));

  // Then extracts FieldInfo for the entity from the optimistic maps
  for (let i = 0, l = currentData!.optimisticOrder.length; i < l; i++) {
    const optimistic = map.optimistic.get(currentData!.optimisticOrder[i]);
    if (optimistic !== undefined) {
      extractNodeFields(fieldInfos, seenFieldKeys, optimistic.get(entityKey));
    }
  }
};

/** Garbage collects all entities that have been marked as having no references */
export const gc = () => {
  // If we're currently awaiting deferred results, abort GC run
  if (currentData!.optimisticOrder.length) return;

  // Iterate over all entities that have been marked for deletion
  // Entities have been marked for deletion in `updateRCForEntity` if
  // their reference count dropped to 0
  for (const entityKey of currentData!.gc.keys()) {
    // Remove the current key from the GC batch
    currentData!.gc.delete(entityKey);

    // Check first whether the entity has any references,
    // if so, we skip it from the GC run
    const rc = getRefCount(entityKey);
    if (rc > 0) continue;

    const record = currentData!.records.base.get(entityKey);
    // Delete the reference count, and delete the entity from the GC batch
    currentData!.refCount.delete(entityKey);
    currentData!.records.base.delete(entityKey);

    const typename = (record && record.__typename) as string | undefined;
    if (typename) {
      const type = currentData!.types.get(typename);
      if (type) type.delete(entityKey);
    }

    const linkNode = currentData!.links.base.get(entityKey);
    if (linkNode) {
      currentData!.links.base.delete(entityKey);
      for (const fieldKey in linkNode) updateRCForLink(linkNode[fieldKey], -1);
    }
  }
};

const updateDependencies = (entityKey: string, fieldKey?: string) => {
  if (entityKey !== currentData!.queryRootKey) {
    currentDependencies!.add(entityKey);
  } else if (fieldKey !== undefined && fieldKey !== '__typename') {
    currentDependencies!.add(joinKeys(entityKey, fieldKey));
  }
};

const updatePersist = (entityKey: string, fieldKey: string) => {
  if (!currentOptimistic && currentData!.storage) {
    currentData!.persist.add(serializeKeys(entityKey, fieldKey));
  }
};

/** Reads an entity's field (a "record") from data */
export const readRecord = (
  entityKey: string,
  fieldKey: string
): EntityField => {
  if (currentOperation === 'read') {
    updateDependencies(entityKey, fieldKey);
  }
  return getNode(currentData!.records, entityKey, fieldKey);
};

/** Reads an entity's link from data */
export const readLink = (
  entityKey: string,
  fieldKey: string
): Link | undefined => {
  if (currentOperation === 'read') {
    updateDependencies(entityKey, fieldKey);
  }
  return getNode(currentData!.links, entityKey, fieldKey);
};

export const getEntitiesForType = (typename: string): Set<string> =>
  currentData!.types.get(typename) || DEFAULT_EMPTY_SET;

export const writeType = (typename: string, entityKey: string) => {
  const existingTypes = currentData!.types.get(typename);
  if (!existingTypes) {
    const typeSet = new Set<string>();
    typeSet.add(entityKey);
    currentData!.types.set(typename, typeSet);
  } else {
    existingTypes.add(entityKey);
  }
};

export const getConcreteTypes = (typename: string): Set<string> =>
  currentData!.abstractToConcreteMap.get(typename) || DEFAULT_EMPTY_SET;

export const writeConcreteType = (
  abstractType: string,
  concreteType: string
) => {
  const existingTypes = currentData!.abstractToConcreteMap.get(abstractType);
  if (!existingTypes) {
    const typeSet = new Set<string>();
    typeSet.add(concreteType);
    currentData!.abstractToConcreteMap.set(abstractType, typeSet);
  } else {
    existingTypes.add(concreteType);
  }
};

/** Writes an entity's field (a "record") to data */
export const writeRecord = (
  entityKey: string,
  fieldKey: string,
  value?: EntityField
) => {
  const existing = getNode(currentData!.records, entityKey, fieldKey);
  if (!isEqualLinkOrScalar(existing, value)) {
    updateDependencies(entityKey, fieldKey);
    updatePersist(entityKey, fieldKey);
  }

  setNode(currentData!.records, entityKey, fieldKey, value);
};

export const hasField = (entityKey: string, fieldKey: string): boolean =>
  readRecord(entityKey, fieldKey) !== undefined ||
  readLink(entityKey, fieldKey) !== undefined;

/** Writes an entity's link to data */
export const writeLink = (
  entityKey: string,
  fieldKey: string,
  link?: Link | undefined
) => {
  // Retrieve the link NodeMap from either an optimistic or the base layer
  const links = currentOptimisticKey
    ? currentData!.links.optimistic.get(currentOptimisticKey)
    : currentData!.links.base;
  // Update the reference count for the link
  if (!currentOptimisticKey) {
    const entityLinks = links && links.get(entityKey);
    updateRCForLink(entityLinks && entityLinks[fieldKey], -1);
    updateRCForLink(link, 1);
  }
  const existing = getNode(currentData!.links, entityKey, fieldKey);
  if (!isEqualLinkOrScalar(existing, link)) {
    updateDependencies(entityKey, fieldKey);
    updatePersist(entityKey, fieldKey);
  }

  // Update the link
  setNode(currentData!.links, entityKey, fieldKey, link);
};

/** Reserves an optimistic layer and preorders it */
export const reserveLayer = (
  data: InMemoryData,
  layerKey: number,
  hasNext?: boolean
) => {
  // Find the current index for the layer, and remove it from
  // the order if it exists already
  let index = data.optimisticOrder.indexOf(layerKey);
  if (index > -1) data.optimisticOrder.splice(index, 1);

  if (hasNext) {
    data.deferredKeys.add(layerKey);
    // If the layer has future results then we'll move it past any layer that's
    // still empty, so currently pending operations will take precedence over it
    for (
      index = index > -1 ? index : 0;
      index < data.optimisticOrder.length &&
      !data.deferredKeys.has(data.optimisticOrder[index]) &&
      (!data.dirtyKeys.has(data.optimisticOrder[index]) ||
        !data.commutativeKeys.has(data.optimisticOrder[index]));
      index++
    );
  } else {
    data.deferredKeys.delete(layerKey);
    // Protect optimistic layers from being turned into non-optimistic layers
    // while preserving optimistic data
    if (index > -1 && !data.commutativeKeys.has(layerKey))
      clearLayer(data, layerKey);
    index = 0;
  }

  // Register the layer with the deferred or "top" index and
  // mark it as commutative
  data.optimisticOrder.splice(index, 0, layerKey);
  data.commutativeKeys.add(layerKey);
};

/** Checks whether a given layer exists */
export const hasLayer = (data: InMemoryData, layerKey: number) =>
  data.commutativeKeys.has(layerKey) ||
  data.optimisticOrder.indexOf(layerKey) > -1;

/** Creates an optimistic layer of links and records */
const createLayer = (data: InMemoryData, layerKey: number) => {
  if (data.optimisticOrder.indexOf(layerKey) === -1) {
    data.optimisticOrder.unshift(layerKey);
  }

  if (!data.dirtyKeys.has(layerKey)) {
    data.dirtyKeys.add(layerKey);
    data.links.optimistic.set(layerKey, new Map());
    data.records.optimistic.set(layerKey, new Map());
  }
};

/** Clears all links and records of an optimistic layer */
const clearLayer = (data: InMemoryData, layerKey: number) => {
  if (data.dirtyKeys.has(layerKey)) {
    data.dirtyKeys.delete(layerKey);
    data.records.optimistic.delete(layerKey);
    data.links.optimistic.delete(layerKey);
    data.deferredKeys.delete(layerKey);
  }
};

/** Deletes links and records of an optimistic layer, and the layer itself */
const deleteLayer = (data: InMemoryData, layerKey: number) => {
  const index = data.optimisticOrder.indexOf(layerKey);
  if (index > -1) {
    data.optimisticOrder.splice(index, 1);
    data.commutativeKeys.delete(layerKey);
  }

  clearLayer(data, layerKey);
};

/** Merges an optimistic layer of links and records into the base data */
const squashLayer = (layerKey: number) => {
  // Hide current dependencies from squashing operations
  const previousDependencies = currentDependencies;
  currentDependencies = new Set();
  currentOperation = 'write';

  const links = currentData!.links.optimistic.get(layerKey);
  if (links) {
    for (const entry of links.entries()) {
      const entityKey = entry[0];
      const keyMap = entry[1];
      for (const fieldKey in keyMap) {
        writeLink(entityKey, fieldKey, keyMap[fieldKey]);
      }
    }
  }

  const records = currentData!.records.optimistic.get(layerKey);
  if (records) {
    for (const entry of records.entries()) {
      const entityKey = entry[0];
      const keyMap = entry[1];
      for (const fieldKey in keyMap) {
        writeRecord(entityKey, fieldKey, keyMap[fieldKey]);
      }
    }
  }

  currentDependencies = previousDependencies;
  deleteLayer(currentData!, layerKey);
};

/** Return an array of FieldInfo (info on all the fields and their arguments) for a given entity */
export const inspectFields = (entityKey: string): FieldInfo[] => {
  const { links, records } = currentData!;
  const fieldInfos: FieldInfo[] = [];
  const seenFieldKeys: Set<string> = new Set();
  // Update dependencies
  updateDependencies(entityKey);
  // Extract FieldInfos to the fieldInfos array for links and records
  // This also deduplicates by keeping track of fieldKeys in the seenFieldKeys Set
  extractNodeMapFields(fieldInfos, seenFieldKeys, entityKey, links);
  extractNodeMapFields(fieldInfos, seenFieldKeys, entityKey, records);
  return fieldInfos;
};

export const persistData = () => {
  if (currentData!.storage) {
    currentOptimistic = true;
    currentOperation = 'read';
    const entries: SerializedEntries = {};
    for (const key of currentData!.persist.keys()) {
      const { entityKey, fieldKey } = deserializeKeyInfo(key);
      let x: void | Link | EntityField;
      if ((x = readLink(entityKey, fieldKey)) !== undefined) {
        entries[key] = `:${stringifyVariables(x)}`;
      } else if ((x = readRecord(entityKey, fieldKey)) !== undefined) {
        entries[key] = stringifyVariables(x);
      } else {
        entries[key] = undefined;
      }
    }

    currentOptimistic = false;
    currentData!.storage.writeData(entries);
    currentData!.persist.clear();
  }
};

export const hydrateData = (
  data: InMemoryData,
  storage: StorageAdapter,
  entries: SerializedEntries
) => {
  initDataState('write', data, null);

  for (const key in entries) {
    const value = entries[key];
    if (value !== undefined) {
      const { entityKey, fieldKey } = deserializeKeyInfo(key);
      if (value[0] === ':') {
        if (readLink(entityKey, fieldKey) === undefined)
          writeLink(entityKey, fieldKey, JSON.parse(value.slice(1)));
      } else {
        if (readRecord(entityKey, fieldKey) === undefined)
          writeRecord(entityKey, fieldKey, JSON.parse(value));
      }
    }
  }

  data.storage = storage;
  data.hydrating = false;
  clearDataState();
};

function isEqualLinkOrScalar(
  a: Link | EntityField | undefined,
  b: Link | EntityField | undefined
) {
  if (typeof a !== typeof b) return false;
  if (a !== b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return !a.some((el, index) => el !== b[index]);
  }

  return true;
}
