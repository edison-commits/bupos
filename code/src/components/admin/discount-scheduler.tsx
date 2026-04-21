'use client';

import React, { useState, useMemo } from 'react';
import { ChevronDown, Plus, Trash2, Edit2, Check } from 'lucide-react';
import { formatCurrency } from "@/lib/format";
interface Category {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  categoryId: string;
}

interface RecurringSchedule {
  type: 'recurring';
  daysOfWeek: number[]; // 0-6 (Sun-Sat)
  startTime: string; // HH:mm
  endTime: string; // HH:mm
}

interface DateRangeSchedule {
  type: 'dateRange';
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

type Schedule = RecurringSchedule | DateRangeSchedule;

interface ScheduledDiscount {
  id: string;
  name: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  schedule: Schedule;
  scope: 'all' | 'category' | 'products';
  scopeValue?: string | string[]; // categoryId or productIds
  active: boolean;
  createdAt: Date;
}

interface DiscountSchedulerProps {
  categories: Category[];
  products: Product[];
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isDiscountActive(discount: ScheduledDiscount): boolean {
  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' +
                      now.getMinutes().toString().padStart(2, '0');

  if (!discount.active) return false;

  if (discount.schedule.type === 'recurring') {
    const schedule = discount.schedule as RecurringSchedule;
    if (!schedule.daysOfWeek.includes(currentDay)) return false;
    return currentTime >= schedule.startTime && currentTime <= schedule.endTime;
  } else {
    const schedule = discount.schedule as DateRangeSchedule;
    const today = now.toISOString().split('T')[0];
    return today >= schedule.startDate && today <= schedule.endDate;
  }
}

function getWeeklyPreview(schedule: Schedule): string[] {
  const preview: string[] = [];

  if (schedule.type === 'recurring') {
    const s = schedule as RecurringSchedule;
    s.daysOfWeek.forEach(day => {
      preview.push(`${DAYS_OF_WEEK[day]} ${s.startTime}-${s.endTime}`);
    });
  } else {
    const s = schedule as DateRangeSchedule;
    preview.push(`${s.startDate} to ${s.endDate}`);
  }

  return preview;
}

export function DiscountScheduler({ categories, products }: DiscountSchedulerProps) {
  const [discounts, setDiscounts] = useState<ScheduledDiscount[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState<Partial<ScheduledDiscount>>({
    name: '',
    discountType: 'percent',
    discountValue: 0,
    schedule: { type: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], startTime: '00:00', endTime: '23:59' } as RecurringSchedule,
    scope: 'all',
    active: true,
  });

  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');

  const activeDiscounts = useMemo(() => discounts.filter(isDiscountActive), [discounts]);

  const handleAddDiscount = () => {
    setEditingId(null);
    setFormData({
      name: '',
      discountType: 'percent',
      discountValue: 0,
      schedule: { type: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], startTime: '00:00', endTime: '23:59' } as RecurringSchedule,
      scope: 'all',
      active: true,
    });
    setSelectedProducts([]);
    setSelectedCategory('');
    setShowForm(true);
  };

  const handleEditDiscount = (discount: ScheduledDiscount) => {
    setEditingId(discount.id);
    setFormData(discount);

    if (discount.scope === 'category') {
      setSelectedCategory(discount.scopeValue as string);
    } else if (discount.scope === 'products') {
      setSelectedProducts(discount.scopeValue as string[]);
    }

    setShowForm(true);
  };

  const handleSaveDiscount = () => {
    if (!formData.name || !formData.discountValue) {
      alert('Please fill in all required fields');
      return;
    }

    let scopeValue: string | string[] | undefined;
    if (formData.scope === 'category') {
      scopeValue = selectedCategory;
      if (!scopeValue) {
        alert('Please select a category');
        return;
      }
    } else if (formData.scope === 'products') {
      if (selectedProducts.length === 0) {
        alert('Please select at least one product');
        return;
      }
      scopeValue = selectedProducts;
    }

    const newDiscount: ScheduledDiscount = {
      id: editingId || Date.now().toString(),
      name: formData.name!,
      discountType: formData.discountType || 'percent',
      discountValue: formData.discountValue!,
      schedule: formData.schedule!,
      scope: formData.scope || 'all',
      scopeValue,
      active: formData.active !== false,
      createdAt: new Date(),
    };

    if (editingId) {
      setDiscounts(discounts.map(d => d.id === editingId ? newDiscount : d));
    } else {
      setDiscounts([...discounts, newDiscount]);
    }

    setShowForm(false);
    setEditingId(null);
  };

  const handleDeleteDiscount = (id: string) => {
    if (confirm('Are you sure you want to delete this discount?')) {
      setDiscounts(discounts.filter(d => d.id !== id));
    }
  };

  const handleToggleActive = (id: string) => {
    setDiscounts(discounts.map(d =>
      d.id === id ? { ...d, active: !d.active } : d
    ));
  };

  const handleScheduleTypeChange = (type: 'recurring' | 'dateRange') => {
    if (type === 'recurring') {
      setFormData({
        ...formData,
        schedule: { type: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], startTime: '00:00', endTime: '23:59' },
      });
    } else {
      setFormData({
        ...formData,
        schedule: { type: 'dateRange', startDate: new Date().toISOString().split('T')[0], endDate: new Date().toISOString().split('T')[0] },
      });
    }
  };

  const handleDayToggle = (day: number) => {
    const schedule = formData.schedule as RecurringSchedule;
    const days = schedule.daysOfWeek;
    if (days.includes(day)) {
      setFormData({
        ...formData,
        schedule: {
          ...schedule,
          daysOfWeek: days.filter(d => d !== day),
        },
      });
    } else {
      setFormData({
        ...formData,
        schedule: {
          ...schedule,
          daysOfWeek: [...days, day].sort(),
        },
      });
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-zinc-900">Discount Scheduler</h1>
            <p className="text-zinc-600 mt-1">Create and manage automated promotions</p>
          </div>
          <button
            onClick={handleAddDiscount}
            className="touch-button flex items-center gap-2 px-6 py-3 bg-teal-700 hover:bg-teal-800 text-white font-medium rounded-2xl transition-colors"
          >
            <Plus className="w-5 h-5" />
            New Discount
          </button>
        </div>

        {/* Active Discounts Summary */}
        {activeDiscounts.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
            <p className="text-emerald-900 font-medium">
              {activeDiscounts.length} discount{activeDiscounts.length !== 1 ? 's' : ''} currently active
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {activeDiscounts.map(d => (
                <span key={d.id} className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-sm font-medium">
                  {d.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Form */}
        {showForm && (
          <div className="bg-zinc-50 border-2 border-zinc-200 rounded-2xl p-6">
            <h2 className="text-xl font-bold text-zinc-900 mb-6">
              {editingId ? 'Edit Discount' : 'Create New Discount'}
            </h2>

            <div className="space-y-6">
              {/* Name and Discount Type Row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-2">
                    Discount Name *
                  </label>
                  <input
                    type="text"
                    placeholder="e.g., Happy Hour, Weekend Sale"
                    value={formData.name || ''}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-2">
                    Discount Type *
                  </label>
                  <select
                    value={formData.discountType || 'percent'}
                    onChange={(e) => setFormData({ ...formData, discountType: e.target.value as 'percent' | 'fixed' })}
                    className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                  >
                    <option value="percent">Percentage Off</option>
                    <option value="fixed">Fixed Dollar Off</option>
                  </select>
                </div>
              </div>

              {/* Discount Value */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-2">
                    Discount Value * {formData.discountType === 'percent' ? '(%)' : '($)'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step={formData.discountType === 'percent' ? '1' : '0.01'}
                    max={formData.discountType === 'percent' ? '100' : undefined}
                    value={formData.discountValue || ''}
                    onChange={(e) => setFormData({ ...formData, discountValue: parseFloat(e.target.value) || 0 })}
                    className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-2">
                    Status
                  </label>
                  <button
                    onClick={() => setFormData({ ...formData, active: !formData.active })}
                    className={`touch-button w-full px-4 py-3 rounded-lg font-medium transition-colors text-white ${
                      formData.active ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-zinc-400 hover:bg-zinc-500'
                    }`}
                  >
                    {formData.active ? 'Active' : 'Inactive'}
                  </button>
                </div>
              </div>

              {/* Schedule Type Selection */}
              <div>
                <label className="block text-sm font-semibold text-zinc-700 mb-3">
                  Schedule Type *
                </label>
                <div className="flex gap-3">
                  <button
                    onClick={() => handleScheduleTypeChange('recurring')}
                    className={`touch-button flex-1 px-4 py-3 rounded-lg font-medium transition-colors ${
                      formData.schedule?.type === 'recurring'
                        ? 'bg-teal-700 text-white'
                        : 'bg-white border-2 border-zinc-300 text-zinc-700 hover:border-teal-700'
                    }`}
                  >
                    Recurring (Weekly)
                  </button>
                  <button
                    onClick={() => handleScheduleTypeChange('dateRange')}
                    className={`touch-button flex-1 px-4 py-3 rounded-lg font-medium transition-colors ${
                      formData.schedule?.type === 'dateRange'
                        ? 'bg-teal-700 text-white'
                        : 'bg-white border-2 border-zinc-300 text-zinc-700 hover:border-teal-700'
                    }`}
                  >
                    Date Range
                  </button>
                </div>
              </div>

              {/* Recurring Schedule */}
              {formData.schedule?.type === 'recurring' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-zinc-700 mb-3">
                      Days of Week *
                    </label>
                    <div className="grid grid-cols-4 md:grid-cols-7 gap-2">
                      {DAYS_OF_WEEK.map((day, index) => (
                        <button
                          key={index}
                          onClick={() => handleDayToggle(index)}
                          className={`touch-button py-2 px-1 rounded-lg font-medium text-sm transition-colors ${
                            (formData.schedule as RecurringSchedule).daysOfWeek.includes(index)
                              ? 'bg-teal-700 text-white'
                              : 'bg-white border-2 border-zinc-300 text-zinc-700 hover:border-teal-700'
                          }`}
                        >
                          {day.slice(0, 3)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-zinc-700 mb-2">
                        Start Time *
                      </label>
                      <input
                        type="time"
                        value={(formData.schedule as RecurringSchedule).startTime}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            schedule: {
                              ...(formData.schedule as RecurringSchedule),
                              startTime: e.target.value,
                            },
                          })
                        }
                        className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-zinc-700 mb-2">
                        End Time *
                      </label>
                      <input
                        type="time"
                        value={(formData.schedule as RecurringSchedule).endTime}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            schedule: {
                              ...(formData.schedule as RecurringSchedule),
                              endTime: e.target.value,
                            },
                          })
                        }
                        className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Date Range Schedule */}
              {formData.schedule?.type === 'dateRange' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-zinc-700 mb-2">
                      Start Date *
                    </label>
                    <input
                      type="date"
                      value={(formData.schedule as DateRangeSchedule).startDate}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          schedule: {
                            ...(formData.schedule as DateRangeSchedule),
                            startDate: e.target.value,
                          },
                        })
                      }
                      className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-zinc-700 mb-2">
                      End Date *
                    </label>
                    <input
                      type="date"
                      value={(formData.schedule as DateRangeSchedule).endDate}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          schedule: {
                            ...(formData.schedule as DateRangeSchedule),
                            endDate: e.target.value,
                          },
                        })
                      }
                      className="w-full px-4 py-3 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                    />
                  </div>
                </div>
              )}

              {/* Scope Selection */}
              <div>
                <label className="block text-sm font-semibold text-zinc-700 mb-3">
                  Applies To *
                </label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer touch-button p-3 rounded-lg hover:bg-zinc-100 transition-colors">
                    <input
                      type="radio"
                      name="scope"
                      value="all"
                      checked={formData.scope === 'all'}
                      onChange={(e) => {
                        setFormData({ ...formData, scope: e.target.value as 'all' | 'category' | 'products' });
                        setSelectedCategory('');
                        setSelectedProducts([]);
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-zinc-700 font-medium">All Products</span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer touch-button p-3 rounded-lg hover:bg-zinc-100 transition-colors">
                    <input
                      type="radio"
                      name="scope"
                      value="category"
                      checked={formData.scope === 'category'}
                      onChange={(e) => {
                        setFormData({ ...formData, scope: e.target.value as 'all' | 'category' | 'products' });
                        setSelectedProducts([]);
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-zinc-700 font-medium">Specific Category</span>
                  </label>

                  {formData.scope === 'category' && (
                    <select
                      value={selectedCategory}
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className="w-full ml-7 px-4 py-2 rounded-lg border border-zinc-300 focus:border-teal-700 focus:outline-none text-zinc-700"
                    >
                      <option value="">Select a category...</option>
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <label className="flex items-center gap-3 cursor-pointer touch-button p-3 rounded-lg hover:bg-zinc-100 transition-colors">
                    <input
                      type="radio"
                      name="scope"
                      value="products"
                      checked={formData.scope === 'products'}
                      onChange={(e) => {
                        setFormData({ ...formData, scope: e.target.value as 'all' | 'category' | 'products' });
                        setSelectedCategory('');
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-zinc-700 font-medium">Specific Products</span>
                  </label>

                  {formData.scope === 'products' && (
                    <div className="ml-7 space-y-2 max-h-64 overflow-y-auto">
                      {products.map((prod) => (
                        <label
                          key={prod.id}
                          className="flex items-center gap-3 cursor-pointer touch-button p-2 rounded-lg hover:bg-zinc-100 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedProducts.includes(prod.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedProducts([...selectedProducts, prod.id]);
                              } else {
                                setSelectedProducts(selectedProducts.filter((id) => id !== prod.id));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <span className="text-zinc-700">{prod.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Form Actions */}
              <div className="flex gap-3 pt-4 border-t border-zinc-200">
                <button
                  onClick={() => {
                    setShowForm(false);
                    setEditingId(null);
                  }}
                  className="touch-button flex-1 px-4 py-3 rounded-lg border-2 border-zinc-300 text-zinc-700 font-medium hover:bg-zinc-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveDiscount}
                  className="touch-button flex-1 px-4 py-3 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  {editingId ? 'Update' : 'Create'} Discount
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Discounts List */}
        <div className="space-y-3">
          {discounts.length === 0 ? (
            <div className="bg-zinc-50 border-2 border-dashed border-zinc-300 rounded-2xl p-12 text-center">
              <p className="text-zinc-600 font-medium mb-3">No discounts scheduled yet</p>
              <button
                onClick={handleAddDiscount}
                className="touch-button inline-flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white font-medium rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create First Discount
              </button>
            </div>
          ) : (
            discounts.map((discount) => {
              const isActive = isDiscountActive(discount);
              const preview = getWeeklyPreview(discount.schedule);

              return (
                <div
                  key={discount.id}
                  className={`rounded-2xl border-2 transition-all ${
                    isActive
                      ? 'border-emerald-300 bg-emerald-50'
                      : 'border-zinc-200 bg-white'
                  }`}
                >
                  {/* Card Header */}
                  <div className="p-4 flex items-center justify-between cursor-pointer touch-button"
                    onClick={() => setExpandedId(expandedId === discount.id ? null : discount.id)}>
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <div>
                          <h3 className="font-bold text-lg text-zinc-900">
                            {discount.name}
                          </h3>
                          <div className="flex flex-wrap gap-2 mt-1">
                            <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                              discount.discountType === 'percent'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-purple-100 text-purple-700'
                            }`}>
                              {discount.discountType === 'percent'
                                ? `${discount.discountValue}% off`
                                : `${formatCurrency(discount.discountValue)} off`}
                            </span>
                            {isActive && (
                              <span className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-emerald-100 text-emerald-700">
                                Active Now
                              </span>
                            )}
                            {!discount.active && (
                              <span className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-zinc-100 text-zinc-700">
                                Disabled
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <ChevronDown
                        className={`w-5 h-5 text-zinc-600 transition-transform ${
                          expandedId === discount.id ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {expandedId === discount.id && (
                    <>
                      <div className="border-t-2 border-zinc-200 px-4 py-4 space-y-4">
                        {/* Schedule Preview */}
                        <div>
                          <h4 className="font-semibold text-zinc-900 text-sm mb-2">Schedule</h4>
                          <div className="space-y-1">
                            {preview.map((line, idx) => (
                              <p key={idx} className="text-zinc-700 text-sm">
                                {line}
                              </p>
                            ))}
                          </div>
                        </div>

                        {/* Scope Info */}
                        <div>
                          <h4 className="font-semibold text-zinc-900 text-sm mb-2">Applies To</h4>
                          <p className="text-zinc-700 text-sm">
                            {discount.scope === 'all' && 'All products'}
                            {discount.scope === 'category' && (
                              <>
                                Category: {categories.find(c => c.id === discount.scopeValue)?.name}
                              </>
                            )}
                            {discount.scope === 'products' && (
                              <>
                                {(discount.scopeValue as string[]).length} product
                                {(discount.scopeValue as string[]).length !== 1 ? 's' : ''}
                              </>
                            )}
                          </p>
                        </div>

                        {/* Weekly Calendar */}
                        {discount.schedule.type === 'recurring' && (
                          <div>
                            <h4 className="font-semibold text-zinc-900 text-sm mb-2">Weekly Availability</h4>
                            <div className="grid grid-cols-7 gap-1">
                              {DAYS_OF_WEEK.map((day, idx) => (
                                <div
                                  key={idx}
                                  className={`aspect-square rounded-lg flex items-center justify-center text-xs font-bold transition-colors ${
                                    (discount.schedule as RecurringSchedule).daysOfWeek.includes(idx)
                                      ? 'bg-teal-700 text-white'
                                      : 'bg-zinc-200 text-zinc-600'
                                  }`}
                                >
                                  {day.slice(0, 1)}
                                </div>
                              ))}
                            </div>
                            <p className="text-zinc-600 text-xs mt-2">
                              {(discount.schedule as RecurringSchedule).startTime} to{' '}
                              {(discount.schedule as RecurringSchedule).endTime}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Card Footer Actions */}
                      <div className="border-t-2 border-zinc-200 px-4 py-4 flex gap-3">
                        <button
                          onClick={() => handleToggleActive(discount.id)}
                          className={`touch-button flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                            discount.active
                              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                              : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                          }`}
                        >
                          {discount.active ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => handleEditDiscount(discount)}
                          className="touch-button px-4 py-2 rounded-lg border-2 border-blue-500 text-blue-600 font-medium hover:bg-blue-50 transition-colors flex items-center gap-2"
                        >
                          <Edit2 className="w-4 h-4" />
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteDiscount(discount.id)}
                          className="touch-button px-4 py-2 rounded-lg border-2 border-red-500 text-red-600 font-medium hover:bg-red-50 transition-colors flex items-center gap-2"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}