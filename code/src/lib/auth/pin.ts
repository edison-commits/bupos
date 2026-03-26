import { employees } from "@/lib/data/mock-data";

export interface PinLoginResult {
  ok: boolean;
  employeeId?: string;
  roleKey?: string;
  reason?: string;
}

export function resolvePinLogin(pin: string): PinLoginResult {
  if (!/^\d{4}$/.test(pin)) {
    return { ok: false, reason: "PINs are four digits." };
  }

  const directory = new Map([
    ["1111", employees[0]],
    ["2222", employees[1]],
    ["3333", employees[2]],
  ]);

  const employee = directory.get(pin);

  if (!employee) {
    return { ok: false, reason: "No employee matched that PIN." };
  }

  return { ok: true, employeeId: employee.id, roleKey: employee.roleKey };
}
