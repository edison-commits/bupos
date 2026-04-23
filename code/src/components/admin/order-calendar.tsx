'use client';

import React, { useState, useMemo, useEffect } from 'react';
import type { EntityId, Supplier, PurchaseOrder } from '@/lib/domain/types';
import { formatCurrency } from "@/lib/format";

// Event types and data structures
export type EventType = 'order_due' | 'order_placed' | 'expected_delivery' | 'delivery_received' | 'custom_note';
export type RecurrenceType = 'none' | 'weekly' | 'biweekly' | 'monthly';
export type CarrierType = 'UPS' | 'FedEx' | 'USPS' | 'DHL' | 'Other';
export type ShipmentStatus = 'ordered' | 'shipped' | 'in_transit' | 'delivered' | 'delayed';

interface StoreLocation {
  id: string;
  name: string;
  code: string;
}

interface CalendarEvent {
  id: string;
  date: Date;
  type: EventType;
  title: string;
  supplierId?: EntityId;
  poId?: EntityId;
  poNumber?: string;
  trackingNumber?: string;
  carrier?: CarrierType;
  amount?: number;
  notes?: string;
  recurrence: RecurrenceType;
  status?: ShipmentStatus;
  locationId?: string;
  createdAt: Date;
}

interface OrderCalendarProps {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  employees: { id: string; displayName: string }[];
  locations: StoreLocation[];
  currentLocationId: string;
}

const EVENT_COLORS: Record<EventType, { bg: string; text: string; dot: string }> = {
  order_due: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  order_placed: { bg: 'bg-teal-50', text: 'text-teal-700', dot: 'bg-teal-500' },
  expected_delivery: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  delivery_received: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  custom_note: { bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-500' },
};

// Distinct colors for each store on the calendar
const STORE_COLORS = [
  { border: 'border-l-teal-500', bg: 'bg-teal-500', text: 'text-teal-700', light: 'bg-teal-100 text-teal-800' },
  { border: 'border-l-violet-500', bg: 'bg-violet-500', text: 'text-violet-700', light: 'bg-violet-100 text-violet-800' },
  { border: 'border-l-amber-500', bg: 'bg-amber-500', text: 'text-amber-700', light: 'bg-amber-100 text-amber-800' },
  { border: 'border-l-rose-500', bg: 'bg-rose-500', text: 'text-rose-700', light: 'bg-rose-100 text-rose-800' },
  { border: 'border-l-sky-500', bg: 'bg-sky-500', text: 'text-sky-700', light: 'bg-sky-100 text-sky-800' },
  { border: 'border-l-lime-500', bg: 'bg-lime-500', text: 'text-lime-700', light: 'bg-lime-100 text-lime-800' },
];

const SHIPMENT_STATUS_COLORS: Record<ShipmentStatus, string> = {
  ordered: 'bg-blue-100 text-blue-800',
  shipped: 'bg-amber-100 text-amber-800',
  in_transit: 'bg-amber-100 text-amber-800',
  delivered: 'bg-emerald-100 text-emerald-800',
  delayed: 'bg-red-100 text-red-800',
};

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getRecurringDates(baseDate: Date, recurrence: RecurrenceType, monthsAhead: number = 3): Date[] {
  if (recurrence === 'none') return [baseDate];

  const dates: Date[] = [baseDate];
  let current = new Date(baseDate);
  const endDate = new Date(baseDate);
  endDate.setMonth(endDate.getMonth() + monthsAhead);

  while (current < endDate) {
    const next = new Date(current);
    if (recurrence === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else if (recurrence === 'biweekly') {
      next.setDate(next.getDate() + 14);
    } else if (recurrence === 'monthly') {
      next.setMonth(next.getMonth() + 1);
    }
    if (next < endDate) {
      dates.push(next);
    }
    current = next;
  }

  return dates;
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function getMonthStartDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
}

function getStoreColor(locationId: string, locations: StoreLocation[]) {
  const idx = locations.findIndex((l) => l.id === locationId);
  return STORE_COLORS[idx >= 0 ? idx % STORE_COLORS.length : 0];
}

export function OrderCalendar({ suppliers, purchaseOrders, employees: _employees, locations, currentLocationId }: OrderCalendarProps) {
  const today = useMemo(() => new Date(), []);
  today.setHours(0, 0, 0, 0);

  const [currentMonth, setCurrentMonth] = useState<Date>(new Date(today));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [editingEvent, setEditingEvent] = useState<Partial<CalendarEvent>>({
    type: 'order_placed',
    recurrence: 'none',
    locationId: currentLocationId,
  });

  // Store visibility: which stores to show on the calendar
  const [visibleStores, setVisibleStores] = useState<Set<string>>(
    new Set(locations.map((l) => l.id))
  );

  const toggleStoreVisibility = (locationId: string) => {
    setVisibleStores((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) {
        // Don't allow deselecting all stores
        if (next.size > 1) next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return next;
    });
  };

  const showAllStores = () => setVisibleStores(new Set(locations.map((l) => l.id)));
  const showOnlyCurrentStore = () => setVisibleStores(new Set([currentLocationId]));

  // Auto-populate events from purchase orders
  useEffect(() => {
    const autoEvents: CalendarEvent[] = [];

    purchaseOrders.forEach((po) => {
      autoEvents.push({
        id: `po-placed-${po.id}`,
        date: new Date(po.id),
        type: 'order_placed',
        title: `Order Placed`,
        supplierId: po.supplierId,
        poId: po.id,
        poNumber: po.orderNumber,
        amount: po.subtotal,
        status: 'ordered',
        notes: po.notes,
        recurrence: 'none',
        locationId: (po as { locationId?: string }).locationId || currentLocationId,
        createdAt: new Date(),
      });

      if (po.expectedDate) {
        const expectedDate = new Date(po.expectedDate);
        autoEvents.push({
          id: `po-expected-${po.id}`,
          date: expectedDate,
          type: 'expected_delivery',
          title: 'Expected Delivery',
          supplierId: po.supplierId,
          poId: po.id,
          poNumber: po.orderNumber,
          status: 'in_transit',
          recurrence: 'none',
          locationId: (po as { locationId?: string }).locationId || currentLocationId,
          createdAt: new Date(),
        });
      }

      if (po.status === 'received') {
        autoEvents.push({
          id: `po-received-${po.id}`,
          date: new Date(),
          type: 'delivery_received',
          title: 'Delivery Received',
          supplierId: po.supplierId,
          poId: po.id,
          poNumber: po.orderNumber,
          status: 'delivered',
          recurrence: 'none',
          locationId: (po as { locationId?: string }).locationId || currentLocationId,
          createdAt: new Date(),
        });
      }
    });

    setEvents((prev) => {
      const userEvents = prev.filter((e) => !e.id.startsWith('po-'));
      return [...userEvents, ...autoEvents];
    });
  }, [purchaseOrders, currentLocationId]);

  // Expand events with recurrence
  const expandedEvents = useMemo(() => {
    const expanded: CalendarEvent[] = [];

    events.forEach((event) => {
      const recurringDates = getRecurringDates(event.date, event.recurrence, 3);
      recurringDates.forEach((date, idx) => {
        expanded.push({
          ...event,
          id: event.recurrence === 'none' ? event.id : `${event.id}-${idx}`,
          date: date,
        });
      });
    });

    return expanded;
  }, [events]);

  // Filter events by visible stores
  const filteredEvents = useMemo(() => {
    return expandedEvents.filter((e) => {
      const loc = e.locationId || currentLocationId;
      return visibleStores.has(loc);
    });
  }, [expandedEvents, visibleStores, currentLocationId]);

  // Group events by date
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();

    filteredEvents.forEach((event) => {
      const dateStr = formatDate(event.date);
      if (!grouped.has(dateStr)) {
        grouped.set(dateStr, []);
      }
      grouped.get(dateStr)!.push(event);
    });

    return grouped;
  }, [filteredEvents]);

  // Calculate summary stats
  const stats = useMemo(() => {
    const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const lastDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);

    const monthEvents = filteredEvents.filter((e) => e.date >= firstDay && e.date <= lastDay);
    const thisMonth = monthEvents.length;

    const upcoming = filteredEvents.filter(
      (e) => e.type === 'expected_delivery' && e.date >= today && e.date <= new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const overdue = filteredEvents.filter(
      (e) => e.type === 'expected_delivery' && e.date < today && e.status !== 'delivered'
    );

    return { thisMonth, upcoming: upcoming.length, overdue: overdue.length };
  }, [filteredEvents, currentMonth, today]);

  // Get active shipments
  const activeShipments = useMemo(() => {
    return filteredEvents
      .filter(
        (e) =>
          (e.type === 'order_placed' || e.type === 'expected_delivery') &&
          (e.status === 'ordered' || e.status === 'in_transit' || e.status === 'shipped')
      )
      .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0))
      .slice(0, 10);
  }, [filteredEvents]);

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1));
  };

  const handleToday = () => {
    setCurrentMonth(new Date(today));
  };

  const handleDayClick = (day: number) => {
    const selectedDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
    setSelectedDay(selectedDate);
    setShowAddForm(false);
    setSelectedEvent(null);
  };

  const handleAddEvent = () => {
    if (!selectedDay) return;

    const newEvent: CalendarEvent = {
      id: `event-${Date.now()}`,
      date: selectedDay,
      type: (editingEvent.type as EventType) || 'custom_note',
      title: editingEvent.title || 'New Event',
      supplierId: editingEvent.supplierId,
      poId: editingEvent.poId,
      poNumber: editingEvent.poNumber,
      trackingNumber: editingEvent.trackingNumber,
      carrier: editingEvent.carrier,
      amount: editingEvent.amount,
      notes: editingEvent.notes,
      recurrence: (editingEvent.recurrence as RecurrenceType) || 'none',
      status: editingEvent.status,
      locationId: editingEvent.locationId || currentLocationId,
      createdAt: new Date(),
    };

    setEvents([...events, newEvent]);
    setEditingEvent({ type: 'order_placed', recurrence: 'none', locationId: currentLocationId });
    setShowAddForm(false);
  };

  const handleDeleteEvent = (eventId: string) => {
    setEvents(events.filter((e) => e.id !== eventId));
    setSelectedEvent(null);
  };

  const getLocationName = (locationId?: string): string => {
    if (!locationId) return locations.find((l) => l.id === currentLocationId)?.name || 'Unknown';
    return locations.find((l) => l.id === locationId)?.name || 'Unknown';
  };

  const monthName = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const daysCount = daysInMonth(currentMonth);
  const startDay = getMonthStartDay(currentMonth);

  const daysCells: (number | null)[] = Array(startDay).fill(null).concat(Array.from({ length: daysCount }, (_, i) => i + 1));

  return (
    <div className="flex flex-col gap-6 p-6 bg-zinc-50 rounded-2xl">

      {/* Store Filter Bar */}
      {locations.length >= 1 && (
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Store Calendars</h3>
              <p className="text-xs text-zinc-500 mt-0.5">Toggle stores to overlay their events on the calendar</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={showAllStores}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors"
              >
                Show All
              </button>
              <button
                type="button"
                onClick={showOnlyCurrentStore}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 transition-colors"
              >
                This Store Only
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {locations.map((loc) => {
              const color = getStoreColor(loc.id, locations);
              const isVisible = visibleStores.has(loc.id);
              const isCurrent = loc.id === currentLocationId;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => toggleStoreVisibility(loc.id)}
                  className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-all border ${
                    isVisible
                      ? `${color.light} border-current`
                      : 'bg-zinc-100 text-zinc-400 border-zinc-200'
                  }`}
                >
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${isVisible ? color.bg : 'bg-zinc-300'}`} />
                  {loc.name}
                  {isCurrent && (
                    <span className="text-xs opacity-60">(current)</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Summary Bar */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600">Events This Month</div>
          <div className="text-2xl font-bold text-zinc-900">{stats.thisMonth}</div>
        </div>
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600">Upcoming Deliveries</div>
          <div className="text-2xl font-bold text-amber-600">{stats.upcoming}</div>
        </div>
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="text-sm text-zinc-600">Overdue Deliveries</div>
          <div className="text-2xl font-bold text-red-600">{stats.overdue}</div>
        </div>
      </div>

      {/* Calendar Header with Navigation */}
      <div className="bg-white rounded-lg p-4 border border-zinc-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-zinc-900">{monthName}</h2>
          <div className="flex gap-2">
            <button
              onClick={handlePrevMonth}
              className="touch-button px-3 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium"
            >
              &larr;
            </button>
            <button
              onClick={handleToday}
              className="touch-button px-4 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium text-sm"
            >
              Today
            </button>
            <button
              onClick={handleNextMonth}
              className="touch-button px-3 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium"
            >
              &rarr;
            </button>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="border border-zinc-200 rounded-lg overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0 bg-zinc-100">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div key={day} className="p-3 text-center font-semibold text-zinc-700 text-sm">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar days */}
          <div className="grid grid-cols-7 gap-0">
            {daysCells.map((day, idx) => {
              const isToday = day && day === today.getDate() && currentMonth.getMonth() === today.getMonth() && currentMonth.getFullYear() === today.getFullYear();
              const dateStr = day ? formatDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)) : '';
              const dayEvents = day ? eventsByDate.get(dateStr) || [] : [];

              return (
                <div
                  key={idx}
                  onClick={() => day && handleDayClick(day)}
                  className={`min-h-24 border border-zinc-200 p-2 cursor-pointer hover:bg-zinc-50 transition ${
                    isToday ? 'ring-2 ring-teal-500 bg-teal-50' : day ? 'bg-white' : 'bg-zinc-100'
                  }`}
                >
                  {day && (
                    <>
                      <div className={`text-sm font-semibold mb-1 ${isToday ? 'text-teal-700' : 'text-zinc-900'}`}>{day}</div>
                      <div className="flex flex-col gap-0.5">
                        {dayEvents.slice(0, 3).map((event) => {
                          const storeColor = getStoreColor(event.locationId || currentLocationId, locations);
                          return (
                            <div
                              key={event.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedEvent(event);
                              }}
                              className={`text-xs px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 truncate ${
                                locations.length >= 1 ? `border-l-2 ${storeColor.border}` : ''
                              } ${EVENT_COLORS[event.type].bg} ${EVENT_COLORS[event.type].text}`}
                            >
                              {locations.length >= 1 && (
                                <span className="font-semibold">{locations.find((l) => l.id === (event.locationId || currentLocationId))?.code || ''}  </span>
                              )}
                              {event.type === 'custom_note' ? '•' : '○'}
                            </div>
                          );
                        })}
                        {dayEvents.length > 3 && <div className="text-xs text-zinc-600">+{dayEvents.length - 3}</div>}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Store legend below calendar when multi-store */}
        {locations.length >= 1 && visibleStores.size > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span className="font-medium">Stores:</span>
            {locations.filter((l) => visibleStores.has(l.id)).map((loc) => {
              const color = getStoreColor(loc.id, locations);
              return (
                <span key={loc.id} className="flex items-center gap-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${color.bg}`} />
                  {loc.name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected Day Details Panel */}
      {selectedDay && !selectedEvent && (
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-zinc-900">
              {selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            </h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="touch-button px-3 py-1 rounded bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm"
            >
              +
            </button>
          </div>

          {showAddForm && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAddEvent();
              }}
              className="space-y-3 mb-4 p-3 bg-zinc-50 rounded-lg border border-zinc-200"
            >
              {/* Store selector */}
              {locations.length >= 1 && (
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1">Store</label>
                  <select
                    value={editingEvent.locationId || currentLocationId}
                    onChange={(e) => setEditingEvent({ ...editingEvent, locationId: e.target.value })}
                    className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                  >
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} {loc.id === currentLocationId ? '(current)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Event Type</label>
                <select
                  value={editingEvent.type}
                  onChange={(e) => setEditingEvent({ ...editingEvent, type: e.target.value as EventType })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                >
                  <option value="order_due">Order Due</option>
                  <option value="order_placed">Order Placed</option>
                  <option value="expected_delivery">Expected Delivery</option>
                  <option value="delivery_received">Delivery Received</option>
                  <option value="custom_note">Custom Note</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Title</label>
                <input
                  type="text"
                  value={editingEvent.title || ''}
                  onChange={(e) => setEditingEvent({ ...editingEvent, title: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                  placeholder="Event title"
                />
              </div>

              {['order_due', 'order_placed', 'expected_delivery'].includes(editingEvent.type || '') && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Supplier</label>
                    <select
                      value={editingEvent.supplierId || ''}
                      onChange={(e) => setEditingEvent({ ...editingEvent, supplierId: e.target.value as EntityId })}
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                    >
                      <option value="">Select supplier</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-zinc-700 mb-1">PO Number</label>
                      <input
                        type="text"
                        value={editingEvent.poNumber || ''}
                        onChange={(e) => setEditingEvent({ ...editingEvent, poNumber: e.target.value })}
                        className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                        placeholder="PO#"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-zinc-700 mb-1">Amount</label>
                      <input
                        type="number"
                        value={editingEvent.amount || ''}
                        onChange={(e) => {
                          // R75-F: guard NaN — parseFloat("") === NaN
                          // which serializes to null or 0 depending
                          // on backend. Fall back to 0.
                          const parsed = parseFloat(e.target.value);
                          setEditingEvent({ ...editingEvent, amount: Number.isFinite(parsed) ? parsed : 0 });
                        }}
                        className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                </>
              )}

              {['expected_delivery', 'delivery_received'].includes(editingEvent.type || '') && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Tracking Number</label>
                    <input
                      type="text"
                      value={editingEvent.trackingNumber || ''}
                      onChange={(e) => setEditingEvent({ ...editingEvent, trackingNumber: e.target.value })}
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                      placeholder="Tracking #"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">Carrier</label>
                    <select
                      value={editingEvent.carrier || ''}
                      onChange={(e) => setEditingEvent({ ...editingEvent, carrier: e.target.value as CarrierType })}
                      className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                    >
                      <option value="">Select carrier</option>
                      <option value="UPS">UPS</option>
                      <option value="FedEx">FedEx</option>
                      <option value="USPS">USPS</option>
                      <option value="DHL">DHL</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Notes</label>
                <textarea
                  value={editingEvent.notes || ''}
                  onChange={(e) => setEditingEvent({ ...editingEvent, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                  placeholder="Additional notes"
                  rows={2}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Recurrence</label>
                <select
                  value={editingEvent.recurrence}
                  onChange={(e) => setEditingEvent({ ...editingEvent, recurrence: e.target.value as RecurrenceType })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-zinc-700 text-sm"
                >
                  <option value="none">None</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="touch-button flex-1 px-3 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white font-medium text-sm"
                >
                  Add Event
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setEditingEvent({ type: 'order_placed', recurrence: 'none', locationId: currentLocationId });
                  }}
                  className="touch-button flex-1 px-3 py-2 rounded bg-zinc-200 hover:bg-zinc-300 text-zinc-700 font-medium text-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2">
            {(eventsByDate.get(formatDate(selectedDay)) || []).map((event) => {
              const storeColor = getStoreColor(event.locationId || currentLocationId, locations);
              return (
                <div
                  key={event.id}
                  onClick={() => setSelectedEvent(event)}
                  className={`p-3 rounded-lg cursor-pointer hover:opacity-80 transition ${EVENT_COLORS[event.type].bg} ${
                    locations.length >= 1 ? `border-l-4 ${storeColor.border}` : 'border border-current'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm">{event.title}</div>
                    {locations.length >= 1 && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${storeColor.light}`}>
                        {getLocationName(event.locationId)}
                      </span>
                    )}
                  </div>
                  {event.poNumber && <div className="text-xs text-zinc-600 mt-0.5">PO: {event.poNumber}</div>}
                </div>
              );
            })}
            {(eventsByDate.get(formatDate(selectedDay)) || []).length === 0 && !showAddForm && (
              <div className="text-sm text-zinc-500">No events scheduled</div>
            )}
          </div>
        </div>
      )}

      {/* Event Detail Panel */}
      {selectedEvent && (
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-zinc-900">{selectedEvent.title}</h3>
            <button
              onClick={() => setSelectedEvent(null)}
              className="touch-button text-zinc-600 hover:text-zinc-900 font-bold"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2 mb-4 text-sm text-zinc-700">
            {/* Store badge */}
            {locations.length >= 1 && (
              <div className="flex items-center gap-2">
                <span className="font-medium">Store:</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStoreColor(selectedEvent.locationId || currentLocationId, locations).light}`}>
                  {getLocationName(selectedEvent.locationId)}
                </span>
              </div>
            )}
            <div>
              <span className="font-medium">Date:</span> {selectedEvent.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
            <div>
              <span className="font-medium">Type:</span> {selectedEvent.type.replace(/_/g, ' ').toUpperCase()}
            </div>
            {selectedEvent.supplierId && (
              <div>
                <span className="font-medium">Supplier:</span> {suppliers.find((s) => s.id === selectedEvent.supplierId)?.name || 'Unknown'}
              </div>
            )}
            {selectedEvent.poNumber && (
              <div>
                <span className="font-medium">PO #:</span> {selectedEvent.poNumber}
              </div>
            )}
            {selectedEvent.amount && (
              <div>
                <span className="font-medium">Amount:</span> {formatCurrency(selectedEvent.amount)}
              </div>
            )}
            {selectedEvent.trackingNumber && (
              <div>
                <span className="font-medium">Tracking:</span> {selectedEvent.trackingNumber}
              </div>
            )}
            {selectedEvent.carrier && (
              <div>
                <span className="font-medium">Carrier:</span> {selectedEvent.carrier}
              </div>
            )}
            {selectedEvent.status && (
              <div>
                <span className="font-medium">Status:</span>{' '}
                <span className={`px-2 py-1 rounded text-xs font-medium ${SHIPMENT_STATUS_COLORS[selectedEvent.status]}`}>
                  {selectedEvent.status}
                </span>
              </div>
            )}
            {selectedEvent.notes && (
              <div>
                <span className="font-medium">Notes:</span> {selectedEvent.notes}
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-3 border-t border-zinc-200">
            <button
              onClick={() => handleDeleteEvent(selectedEvent.id)}
              className="touch-button flex-1 px-3 py-2 rounded bg-red-100 hover:bg-red-200 text-red-700 font-medium text-sm"
            >
              Delete
            </button>
            {selectedEvent.type === 'expected_delivery' && selectedEvent.status !== 'delivered' && (
              <button
                onClick={() => {
                  const updated = {
                    ...selectedEvent,
                    status: 'delivered' as ShipmentStatus,
                  };
                  setEvents(events.map((e) => (e.id === selectedEvent.id ? updated : e)));
                  setSelectedEvent(updated);
                }}
                className="touch-button flex-1 px-3 py-2 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-700 font-medium text-sm"
              >
                Mark Received
              </button>
            )}
          </div>
        </div>
      )}

      {/* Shipment Tracking Section */}
      {activeShipments.length > 0 && (
        <div className="bg-white rounded-lg p-4 border border-zinc-200">
          <h3 className="font-bold text-zinc-900 mb-4">Active Shipments</h3>
          <div className="space-y-2 overflow-x-auto">
            {activeShipments.map((shipment) => {
              const storeColor = getStoreColor(shipment.locationId || currentLocationId, locations);
              return (
                <div key={shipment.id} className={`flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-200 text-sm ${locations.length >= 1 ? `border-l-4 ${storeColor.border}` : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900">
                        {suppliers.find((s) => s.id === shipment.supplierId)?.name || 'Unknown Supplier'}
                      </span>
                      {locations.length >= 1 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${storeColor.light}`}>
                          {getLocationName(shipment.locationId)}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-600">
                      {shipment.poNumber && `PO: ${shipment.poNumber}`}
                      {shipment.trackingNumber && ` • ${shipment.trackingNumber}`}
                      {shipment.carrier && ` • ${shipment.carrier}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${SHIPMENT_STATUS_COLORS[shipment.status || 'ordered']}`}>
                      {(shipment.status || 'ordered').replace('_', ' ')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
