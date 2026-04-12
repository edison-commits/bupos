'use client';

import { useState, useMemo } from 'react';

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  loyaltyPoints: number;
  totalSpend: number;
  visitCount: number;
  email?: string;
  phone?: string;
  isActive: boolean;
}

interface LoyaltyConfig {
  earnRatePerDollar: number;
  redemptionValuePerPoint: number;
  minimumRedemption: number;
}

interface Tier {
  id: string;
  name: string;
  color: string;
  minPoints: number;
  maxPoints: number | null;
  earnMultiplier: number;
  redemptionBonus: number;
  perks: string[];
  congratsMessage: string;
}

interface LoyaltyTiersProps {
  customers: Customer[];
  currentConfig: LoyaltyConfig;
}

const DEFAULT_TIERS: Tier[] = [
  {
    id: 'bronze',
    name: 'Bronze',
    color: '#cd7f32',
    minPoints: 0,
    maxPoints: 499,
    earnMultiplier: 1,
    redemptionBonus: 0,
    perks: [],
    congratsMessage: 'Welcome to our loyalty program! Start earning points with every purchase.',
  },
  {
    id: 'silver',
    name: 'Silver',
    color: '#c0c0c0',
    minPoints: 500,
    maxPoints: 1499,
    earnMultiplier: 1.5,
    redemptionBonus: 5,
    perks: ['5% bonus on point redemption'],
    congratsMessage: 'Congratulations! You\'ve reached Silver tier and unlocked exclusive benefits!',
  },
  {
    id: 'gold',
    name: 'Gold',
    color: '#ffd700',
    minPoints: 1500,
    maxPoints: 4999,
    earnMultiplier: 2,
    redemptionBonus: 10,
    perks: ['10% bonus on redemption', 'Free gift wrapping'],
    congratsMessage: 'Amazing! You\'ve unlocked Gold tier status with premium perks!',
  },
  {
    id: 'platinum',
    name: 'Platinum',
    color: '#e5e4e2',
    minPoints: 5000,
    maxPoints: null,
    earnMultiplier: 3,
    redemptionBonus: 15,
    perks: ['15% bonus on redemption', 'Free gift wrapping', 'Priority service'],
    congratsMessage: 'Elite status! Welcome to Platinum tier. You\'ve unlocked our highest rewards!',
  },
];

export function LoyaltyTiers({ customers, currentConfig }: LoyaltyTiersProps) {
  const [tiers, setTiers] = useState<Tier[]>(DEFAULT_TIERS);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTierId, setEditingTierId] = useState<string | null>(null);
  const [expandedTier, setExpandedTier] = useState<string | null>(null);

  const customersByTier = useMemo(() => {
    const map: Record<string, Customer[]> = {};
    tiers.forEach((tier) => {
      map[tier.id] = customers.filter((c) => {
        const points = c.loyaltyPoints;
        return points >= tier.minPoints && (tier.maxPoints === null || points <= tier.maxPoints);
      });
    });
    return map;
  }, [customers, tiers]);

  const analytics = useMemo(() => {
    const activeCustomers = customers.filter((c) => c.isActive);
    const totalPoints = activeCustomers.reduce((sum, c) => sum + c.loyaltyPoints, 0);
    const avgPoints = activeCustomers.length > 0 ? totalPoints / activeCustomers.length : 0;
    const maxHolder = activeCustomers.reduce((max, c) => (c.loyaltyPoints > max.loyaltyPoints ? c : max), activeCustomers[0] || { loyaltyPoints: 0 } as Customer);
    const potentialLiability = totalPoints * currentConfig.redemptionValuePerPoint;

    const closeToNextTier = activeCustomers.filter((c) => {
      const currentTier = tiers.find((t) => c.loyaltyPoints >= t.minPoints && (t.maxPoints === null || c.loyaltyPoints <= t.maxPoints));
      const nextTier = tiers.find((t) => t.minPoints > c.loyaltyPoints);
      if (!nextTier) return false;
      const pointsNeeded = nextTier.minPoints - c.loyaltyPoints;
      return pointsNeeded <= nextTier.minPoints * 0.1;
    }).length;

    return { totalPoints, avgPoints, maxHolder, potentialLiability, closeToNextTier };
  }, [customers, tiers, currentConfig]);

  const getCustomerTier = (customer: Customer): Tier | undefined => {
    return tiers.find((t) => customer.loyaltyPoints >= t.minPoints && (t.maxPoints === null || customer.loyaltyPoints <= t.maxPoints));
  };

  const getPointsToNextTier = (customer: Customer): { points: number; tier: Tier } | null => {
    const nextTier = tiers.find((t) => t.minPoints > customer.loyaltyPoints);
    if (!nextTier) return null;
    return { points: nextTier.minPoints - customer.loyaltyPoints, tier: nextTier };
  };

  const filteredCustomers = customers.filter((c) => {
    const tierName = getCustomerTier(c)?.name || 'Unknown';
    const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();
    const query = searchQuery.toLowerCase();
    return fullName.includes(query) || tierName.toLowerCase().includes(query);
  });

  const maxCustomersInTier = Math.max(...tiers.map((t) => customersByTier[t.id]?.length || 0), 1);

  const handleTierChange = (tierId: string, field: string, value: string | number | null) => {
    setTiers((prev) =>
      prev.map((t) =>
        t.id === tierId
          ? { ...t, [field]: value }
          : t
      )
    );
  };

  const handleAddCustomTier = () => {
    const newTier: Tier = {
      id: `custom-${Date.now()}`,
      name: 'Custom Tier',
      color: '#808080',
      minPoints: 10000,
      maxPoints: 19999,
      earnMultiplier: 2.5,
      redemptionBonus: 12,
      perks: [],
      congratsMessage: 'Welcome to Custom Tier!',
    };
    setTiers((prev) => [...prev, newTier]);
  };

  return (
    <div className="w-full max-w-7xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-zinc-900">Loyalty Tier Management</h1>
        <p className="text-zinc-600">Configure tiers, view distribution, and manage customer tier progression</p>
      </div>

      {/* Analytics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-2xl bg-zinc-50 p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600 font-medium">Total Points in Circulation</div>
          <div className="text-2xl font-bold text-zinc-900 mt-2">{Math.floor(analytics.totalPoints).toLocaleString()}</div>
          <div className="text-xs text-zinc-500 mt-1">Across all active customers</div>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600 font-medium">Avg Points per Customer</div>
          <div className="text-2xl font-bold text-zinc-900 mt-2">{Math.floor(analytics.avgPoints).toLocaleString()}</div>
          <div className="text-xs text-zinc-500 mt-1">Current portfolio</div>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600 font-medium">Point Liability</div>
          <div className="text-2xl font-bold text-zinc-900 mt-2">${analytics.potentialLiability.toFixed(2)}</div>
          <div className="text-xs text-zinc-500 mt-1">Current redemption value</div>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600 font-medium">Customers Close to Tier Up</div>
          <div className="text-2xl font-bold text-zinc-900 mt-2">{analytics.closeToNextTier}</div>
          <div className="text-xs text-zinc-500 mt-1">Within 10% of next tier</div>
        </div>
      </div>

      {/* Tier Distribution */}
      <div className="rounded-2xl bg-zinc-50 p-6 border border-zinc-200">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Tier Distribution</h2>
        <div className="space-y-3">
          {tiers.map((tier) => {
            const count = customersByTier[tier.id]?.length || 0;
            const percentage = (count / Math.max(customers.length, 1)) * 100;
            return (
              <div key={tier.id} className="space-y-1">
                <div className="flex justify-between items-center text-sm">
                  <span className="font-medium text-zinc-700">{tier.name}</span>
                  <span className="text-zinc-600">{count} customers ({Math.round(percentage)}%)</span>
                </div>
                <div className="w-full bg-zinc-200 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(percentage, 5)}%`,
                      backgroundColor: tier.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tier Configuration */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-bold text-zinc-900">Tier Configuration</h2>
          <button
            onClick={handleAddCustomTier}
            className="px-4 py-2 rounded-lg bg-teal-700 text-white font-medium touch-button hover:bg-teal-800"
          >
            + Add Custom Tier
          </button>
        </div>
        <div className="grid gap-4">
          {tiers.map((tier) => (
            <div key={tier.id} className="rounded-2xl bg-zinc-50 border border-zinc-200 p-4">
              <div
                className="flex justify-between items-start cursor-pointer"
                onClick={() => setExpandedTier(expandedTier === tier.id ? null : tier.id)}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: tier.color }}
                  />
                  <div>
                    <div className="font-bold text-zinc-900">{tier.name}</div>
                    <div className="text-sm text-zinc-600">{customersByTier[tier.id]?.length || 0} customers</div>
                  </div>
                </div>
                <div className="text-zinc-600">{tier.minPoints.toLocaleString()} - {tier.maxPoints ? tier.maxPoints.toLocaleString() : '∞'} pts</div>
              </div>

              {expandedTier === tier.id && (
                <div className="mt-4 space-y-4 border-t border-zinc-200 pt-4">
                  {/* Point Requirements */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3">Point Requirements</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Minimum Points</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={tier.minPoints}
                          onChange={(e) => handleTierChange(tier.id, 'minPoints', Math.max(0, parseInt(e.target.value) || 0))}
                          className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Maximum Points</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={tier.maxPoints ?? ''}
                            placeholder="Unlimited"
                            disabled={tier.maxPoints === null}
                            onChange={(e) => handleTierChange(tier.id, 'maxPoints', e.target.value === '' ? null : Math.max(0, parseInt(e.target.value) || 0))}
                            className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900 placeholder-zinc-400 disabled:bg-zinc-100 disabled:text-zinc-400"
                          />
                          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-zinc-600 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={tier.maxPoints === null}
                              onChange={(e) => handleTierChange(tier.id, 'maxPoints', e.target.checked ? null : (tier.minPoints + 999))}
                              className="rounded"
                            />
                            No limit
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Tier Details */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3">Tier Details</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Tier Name</label>
                        <input
                          type="text"
                          value={tier.name}
                          onChange={(e) => handleTierChange(tier.id, 'name', e.target.value)}
                          className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900 placeholder-zinc-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Color</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={tier.color}
                            onChange={(e) => handleTierChange(tier.id, 'color', e.target.value)}
                            className="h-9 w-9 cursor-pointer rounded border border-zinc-300 p-0.5"
                          />
                          <input
                            type="text"
                            value={tier.color}
                            onChange={(e) => handleTierChange(tier.id, 'color', e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900 placeholder-zinc-500"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Earn & Redeem */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3">Earn &amp; Redeem</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Earn Multiplier</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={tier.earnMultiplier}
                          onChange={(e) => handleTierChange(tier.id, 'earnMultiplier', parseFloat(e.target.value) || 1)}
                          className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900"
                        />
                        <p className="mt-1 text-xs text-zinc-500">Points earned per dollar spent (base × multiplier)</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-1">Redemption Bonus %</label>
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={tier.redemptionBonus}
                          onChange={(e) => handleTierChange(tier.id, 'redemptionBonus', parseFloat(e.target.value) || 0)}
                          className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900"
                        />
                        <p className="mt-1 text-xs text-zinc-500">Extra value added when redeeming points</p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Congratulations Message</label>
                    <textarea
                      value={tier.congratsMessage}
                      onChange={(e) => handleTierChange(tier.id, 'congratsMessage', e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900 placeholder-zinc-500"
                    />
                  </div>

                  {/* Delete custom tier */}
                  {tier.id.startsWith('custom-') && (
                    <button
                      type="button"
                      onClick={() => setTiers((prev) => prev.filter((t) => t.id !== tier.id))}
                      className="text-sm font-medium text-red-600 hover:text-red-700"
                    >
                      Remove this tier
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Tier Benefits Comparison */}
      <div className="rounded-2xl bg-zinc-50 p-6 border border-zinc-200">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Tier Benefits Comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200">
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Tier</th>
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Earn Rate</th>
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Redemption Bonus</th>
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Perks</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id} className="border-b border-zinc-200 hover:bg-white transition-colors">
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tier.color }} />
                      <span className="font-medium text-zinc-900">{tier.name}</span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-zinc-700">{tier.earnMultiplier}x</td>
                  <td className="py-3 px-3 text-zinc-700">+{tier.redemptionBonus}%</td>
                  <td className="py-3 px-3 text-zinc-700">
                    {tier.perks.length > 0 ? tier.perks.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Tier List */}
      <div className="rounded-2xl bg-zinc-50 p-6 border border-zinc-200">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-zinc-900">Customer Tiers</h2>
          <input
            type="text"
            placeholder="Search by name or tier..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-3 py-2 rounded-lg border border-zinc-300 text-zinc-900 placeholder-zinc-500 w-64"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200">
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Customer</th>
                <th className="text-left py-2 px-3 font-bold text-zinc-900">Tier</th>
                <th className="text-right py-2 px-3 font-bold text-zinc-900">Points</th>
                <th className="text-right py-2 px-3 font-bold text-zinc-900">Total Spend</th>
                <th className="text-center py-2 px-3 font-bold text-zinc-900">Progress to Next</th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.slice(0, 10).map((customer) => {
                const tier = getCustomerTier(customer);
                const nextTier = getPointsToNextTier(customer);
                const progressPercent = nextTier ? Math.min(100, ((nextTier.tier.minPoints - (nextTier.points)) / nextTier.tier.minPoints) * 100) : 100;
                return (
                  <tr key={customer.id} className="border-b border-zinc-200 hover:bg-white transition-colors">
                    <td className="py-3 px-3">
                      <div>
                        <div className="font-medium text-zinc-900">{customer.firstName} {customer.lastName}</div>
                        <div className="text-xs text-zinc-500">{customer.visitCount} visits</div>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      {tier ? (
                        <div
                          className="inline-block px-3 py-1 rounded-full text-white font-medium text-xs"
                          style={{ backgroundColor: tier.color }}
                        >
                          {tier.name}
                        </div>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right text-zinc-900 font-medium">{customer.loyaltyPoints.toLocaleString()}</td>
                    <td className="py-3 px-3 text-right text-zinc-700">${customer.totalSpend.toFixed(2)}</td>
                    <td className="py-3 px-3">
                      {nextTier ? (
                        <div className="space-y-1">
                          <div className="w-32 bg-zinc-300 rounded-full h-2 overflow-hidden mx-auto">
                            <div
                              className="h-full rounded-full bg-teal-700 transition-all duration-300"
                              style={{ width: `${progressPercent}%` }}
                            />
                          </div>
                          <div className="text-xs text-zinc-600 text-center">{nextTier.points.toLocaleString()} pts to {nextTier.tier.name}</div>
                        </div>
                      ) : (
                        <div className="text-xs text-center text-zinc-600">Max Tier</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredCustomers.length > 10 && (
          <div className="mt-3 text-center text-sm text-zinc-600">
            Showing 10 of {filteredCustomers.length} customers
          </div>
        )}
      </div>
    </div>
  );
}
