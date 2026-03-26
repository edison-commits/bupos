import type { ApprovalThresholds } from "@/lib/domain/types";

export const defaultApprovalThresholds: ApprovalThresholds = {
  discountOver: 5,
  itemVoidOver: 15,
  transactionVoidOver: 20,
  storeCreditIssuanceOver: 10,
  manualPriceOverrideOver: 10,
  returnWithoutManagerOver: 40,
};
