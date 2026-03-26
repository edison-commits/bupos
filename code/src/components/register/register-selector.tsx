"use client";

import { cn } from "@/lib/utils/cn";
import type { Register } from "@/lib/domain/types";

export interface RegisterSelectorProps {
  registers: Register[];
  onSelect: (registerId: string) => void;
}

export function RegisterSelector({
  registers,
  onSelect,
}: RegisterSelectorProps) {
  const activeRegisters = registers.filter((r) => r.isActive);

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          Select register
        </h2>
        <p className="text-sm text-zinc-600">
          Choose which register terminal you'll be using for this session.
        </p>
      </div>

      {activeRegisters.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-6 py-8 text-center">
          <p className="text-sm text-zinc-600">
            No active registers available at this location.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {activeRegisters.map((register) => (
            <button
              key={register.id}
              onClick={() => onSelect(register.id)}
              className={cn(
                "touch-button rounded-2xl border-2 px-4 py-5 transition-all",
                "flex flex-col items-center justify-center gap-2",
                "border-zinc-200 bg-white hover:border-teal-300 hover:bg-teal-50",
                "focus:outline-none focus:ring-2 focus:ring-teal-400 focus:ring-offset-2"
              )}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-lg font-semibold text-zinc-900">
                  {register.name}
                </span>
                <span className="text-xs font-mono text-zinc-500">
                  {register.code}
                </span>
              </div>
              <div className="mt-1 inline-block rounded-full bg-emerald-100 px-2 py-1">
                <span className="text-xs font-medium text-emerald-700">
                  Active
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
