import { PublicKey } from "@hiero-ledger/sdk";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
  type FacilitatorClient,
} from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const FACILITATOR_URL = "https://api.testnet.blocky402.com";
const HEDERA_TESTNET = "hedera:testnet";
const HBAR_ASSET_ID = "0.0.0";
const MAX_INT64 = 9_223_372_036_854_775_807n;
const numericAccountIdPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const minimalUnsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;

export interface OperationalPaymentAccount {
  readonly accountId: string;
  readonly publicKey: PublicKey;
}

export interface TreasuryAuthorization {
  readonly accountId: string;
  readonly ownerPublicKey: PublicKey;
  readonly agentPublicKey: PublicKey;
  readonly guardPublicKey: PublicKey;
}

export interface PaymentGateConfig {
  readonly resourceUrl: string;
  readonly priceTinybars: string;
  readonly operationalAccount: OperationalPaymentAccount;
  readonly treasuryAuthorization: TreasuryAuthorization;
}

export type PaymentGateOutcome =
  | {
      readonly paid: true;
      readonly settlementId: string;
      readonly responseHeaders: Readonly<Record<string, string>>;
    }
  | {
      readonly paid: false;
      readonly status: 402;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: unknown;
    };

export interface PaymentGate {
  review(paymentSignatureHeader?: string): Promise<PaymentGateOutcome>;
}

function requireNumericAccountId(value: string, field: string): void {
  if (!numericAccountIdPattern.test(value)) {
    throw new Error(`${field} must be a canonical numeric Hedera account ID`);
  }
}

function validateConfig(config: PaymentGateConfig): void {
  requireNumericAccountId(
    config.operationalAccount.accountId,
    "operational payment accountId",
  );
  requireNumericAccountId(
    config.treasuryAuthorization.accountId,
    "treasury accountId",
  );

  if (
    config.operationalAccount.accountId === config.treasuryAuthorization.accountId
  ) {
    throw new Error(
      "operational payment account must differ from the treasury account",
    );
  }

  if (!(config.operationalAccount.publicKey instanceof PublicKey)) {
    throw new Error("operational payment key must be a single public key");
  }

  const authorizationKeys = [
    config.treasuryAuthorization.ownerPublicKey,
    config.treasuryAuthorization.agentPublicKey,
    config.treasuryAuthorization.guardPublicKey,
  ];
  if (authorizationKeys.some((key) => !(key instanceof PublicKey))) {
    throw new Error("treasury authorization keys must be single public keys");
  }
  if (
    authorizationKeys.some((key) =>
      config.operationalAccount.publicKey.equals(key),
    )
  ) {
    throw new Error(
      "operational payment key must be separate from treasury authorization keys",
    );
  }

  if (!minimalUnsignedDecimalPattern.test(config.priceTinybars)) {
    throw new Error("priceTinybars must be a minimal unsigned decimal string");
  }
  const priceTinybars = BigInt(config.priceTinybars);
  if (priceTinybars === 0n) {
    throw new Error("priceTinybars must be positive");
  }
  if (priceTinybars > MAX_INT64) {
    throw new Error("priceTinybars exceeds the Hedera int64 limit");
  }
}

function requestAdapter(
  resourceUrl: string,
  paymentSignatureHeader?: string,
): HTTPAdapter {
  return {
    getHeader(name: string): string | undefined {
      return name.toLowerCase() === "payment-signature"
        ? paymentSignatureHeader
        : undefined;
    },
    getMethod: () => "POST",
    getPath: () => "/review",
    getUrl: () => resourceUrl,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "Countersign",
  };
}

export async function createPaymentGate(
  config: PaymentGateConfig,
  facilitatorClient: FacilitatorClient = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
  }),
): Promise<PaymentGate> {
  validateConfig(config);

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    HEDERA_TESTNET,
    new ExactHederaScheme(),
  );
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /review": {
      accepts: {
        scheme: "exact",
        network: HEDERA_TESTNET,
        payTo: config.operationalAccount.accountId,
        price: {
          asset: HBAR_ASSET_ID,
          amount: config.priceTinybars,
        },
        extra: { paymentFlow: "upfront" },
      },
      resource: config.resourceUrl,
      description: "Countersign schedule review check",
      mimeType: "application/json",
      serviceName: "Countersign",
    },
  });
  await httpServer.initialize();

  return {
    async review(
      paymentSignatureHeader?: string,
    ): Promise<PaymentGateOutcome> {
      const result = await httpServer.processHTTPRequest({
        adapter: requestAdapter(config.resourceUrl, paymentSignatureHeader),
        path: "/review",
        method: "POST",
        paymentHeader: paymentSignatureHeader,
      });

      if (result.type === "payment-error") {
        if (result.response.status !== 402) {
          throw new Error(
            `unexpected x402 payment response status: ${result.response.status}`,
          );
        }
        return {
          paid: false,
          status: 402,
          headers: result.response.headers,
          body: result.response.body,
        };
      }

      if (result.type !== "payment-verified") {
        throw new Error("review endpoint was not protected by the payment gate");
      }
      if (result.beforeHandlerSettlement === undefined) {
        throw new Error("review payment was not settled before privileged work");
      }

      const settlementId = result.beforeHandlerSettlement.result.transaction;
      if (settlementId.length === 0) {
        throw new Error("review payment settlement id is missing");
      }

      return {
        paid: true,
        settlementId,
        responseHeaders: httpServer.createCompletedSettlementHeaders(
          result.beforeHandlerSettlement,
        ),
      };
    },
  };
}
