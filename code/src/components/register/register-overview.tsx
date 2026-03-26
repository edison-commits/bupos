import { employees, locations, registerConfiguration, transactionExceptionPlaceholders } from "@/lib/data/mock-data";
import { SectionCard } from "@/components/ui/section-card";
import { PinPadPreview } from "@/components/register/pin-pad-preview";

export function RegisterOverview() {
  const activeStaff = employees.filter((employee) => employee.isActive);

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="grid gap-6">
        <SectionCard
          title="Register operating profile"
          description="Milestone 0–1 keeps the register lean: PIN accountability, tender readiness, manager approvals, and a touchscreen-first posture."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="panel-muted rounded-2xl border border-zinc-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Location</p>
              <p className="mt-2 text-xl font-semibold">{locations[0].name}</p>
              <p className="mt-1 text-sm text-zinc-600">{locations[0].address1}, {locations[0].city}</p>
            </div>
            <div className="panel-muted rounded-2xl border border-zinc-200 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Tenders reserved for V1</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {registerConfiguration.supportedTenders.map((tender) => (
                  <span key={tender} className="rounded-full bg-zinc-900 px-3 py-1 text-sm font-medium text-white">
                    {tender}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Approval thresholds"
          description="Hard-coded defaults now, but shaped as configuration for a later settings surface."
        >
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(registerConfiguration.approvalThresholds).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between rounded-2xl border border-zinc-200 px-4 py-3">
                <span className="text-sm font-medium text-zinc-700">{key}</span>
                <span className="text-base font-semibold">${value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-6">
        <SectionCard title="PIN login preview" description="Large tap targets and fast employee switching come before full session state.">
          <div className="mb-4 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
            Demo PINs: 1111 owner · 2222 manager · 3333 cashier
          </div>
          <PinPadPreview />
        </SectionCard>

        <SectionCard title="Accountability signal" description="Exceptions and approvals get first-class structure before checkout logic lands.">
          <ul className="space-y-3 text-sm text-zinc-700">
            <li>{activeStaff.length} active employees available for PIN login.</li>
            <li>{transactionExceptionPlaceholders.length} transaction exception placeholder wired into the foundation.</li>
            <li>No receipt is explicitly allowed in configuration, but browser print stays the default path.</li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
