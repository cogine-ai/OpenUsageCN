import { invoke } from "@tauri-apps/api/core"

import type {
  ProviderAccountOperation,
  ProviderAccountOperationReceipt,
  ProviderAccountView,
} from "@/lib/plugin-types"

export function getProviderAccountView(providerId: string): Promise<ProviderAccountView> {
  return invoke<ProviderAccountView>("get_provider_account_view", { providerId })
}

export function performProviderAccountOperation(
  providerId: string,
  operation: ProviderAccountOperation
): Promise<ProviderAccountOperationReceipt> {
  return invoke<ProviderAccountOperationReceipt>("perform_provider_account_operation", {
    providerId,
    operation,
  })
}
