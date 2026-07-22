(() => {
  const api = globalThis.TabSnapshot

  const getTierIndex = (ageMinute, tiers) => {
    const index = tiers.findIndex((tier) => (
      tier.ageMaxMinute === null || ageMinute < tier.ageMaxMinute
    ))
    return index === -1 ? tiers.length - 1 : index
  }

  api.getSnapshotIdsDeleteByRetention = (snapshotItems, config, timeNowMs = Date.now()) => {
    const itemsSorted = [...snapshotItems].sort(
      (itemA, itemB) => itemB.snapshotGenerateAtMs - itemA.snapshotGenerateAtMs
    )
    if (itemsSorted.length <= 1) return []

    const itemsByTier = config.retentionTiers.map(() => [])
    for (const item of itemsSorted) {
      const ageMinute = Math.max(0, (timeNowMs - item.snapshotGenerateAtMs) / 60000)
      itemsByTier[getTierIndex(ageMinute, config.retentionTiers)].push(item)
    }

    const snapshotIdsKeep = new Set([itemsSorted[0].snapshotId])
    for (let tierIndex = 0; tierIndex < itemsByTier.length; tierIndex += 1) {
      const itemsTier = itemsByTier[tierIndex]
      if (itemsTier.length === 0) continue
      const spacingMs = config.retentionTiers[tierIndex].spacingMinMinute * 60000
      let itemKeptLast = itemsTier[0]
      snapshotIdsKeep.add(itemKeptLast.snapshotId)
      for (const item of itemsTier.slice(1)) {
        if (item.isPinned === true) {
          snapshotIdsKeep.add(item.snapshotId)
          itemKeptLast = item
          continue
        }
        if (itemKeptLast.snapshotGenerateAtMs - item.snapshotGenerateAtMs >= spacingMs) {
          snapshotIdsKeep.add(item.snapshotId)
          itemKeptLast = item
        }
      }
    }

    return itemsSorted
      .filter((item) => !snapshotIdsKeep.has(item.snapshotId))
      .map((item) => item.snapshotId)
  }

  api.cleanSnapshotsByRetention = async () => {
    const [catalog, config] = await Promise.all([
      api.getSnapshotCatalog(),
      api.getConfig()
    ])
    const snapshotIdsDelete = api.getSnapshotIdsDeleteByRetention(
      catalog.snapshotItems,
      config
    )
    if (snapshotIdsDelete.length > 0) {
      await api.deleteSnapshots(snapshotIdsDelete)
    }
    const timeMs = Date.now()
    await api.updateMaintenance({ retentionLastAtMs: timeMs })
    return {
      snapshotCountDeleted: snapshotIdsDelete.length,
      snapshotIdsDeleted: snapshotIdsDelete
    }
  }
})()
