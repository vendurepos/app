import type { SimpleGraphQLClient } from '@vendure/testing';
import { parse } from 'graphql';

// Storefront fixtures for proofs 3 and 4: a normal shipping method and Vendure's dummy payment method.
export async function createStorefrontMethods(adminClient: SimpleGraphQLClient) {
  const { createShippingMethod } = await adminClient.query<{ createShippingMethod: { id: string; code: string } }>(parse(`
    mutation { createShippingMethod(input: {
      code: "standard", fulfillmentHandler: "manual-fulfillment",
      checker: { code: "default-shipping-eligibility-checker", arguments: [{ name: "orderMinimum", value: "0" }] },
      calculator: { code: "default-shipping-calculator", arguments: [
        { name: "rate", value: "500" }, { name: "includesTax", value: "auto" }, { name: "taxRate", value: "0" }
      ] },
      translations: [{ languageCode: en, name: "Standard", description: "" }]
    }) { id code } }`));
  const { createPaymentMethod } = await adminClient.query<{ createPaymentMethod: { id: string; code: string } }>(parse(`
    mutation { createPaymentMethod(input: {
      code: "dummy", enabled: true,
      handler: { code: "dummy-payment-handler", arguments: [{ name: "automaticSettle", value: "true" }] },
      translations: [{ languageCode: en, name: "Dummy", description: "" }]
    }) { id code } }`));
  return { standardShippingId: createShippingMethod.id, dummyPaymentCode: createPaymentMethod.code };
}

const ORDER = 'id code state totalWithTax payments { state amount method errorMessage }';
const RESULT = `... on Order { ${ORDER} } ... on ErrorResult { errorCode message }`;

export type ShopOrder = {
  id: string; code: string; state: string; totalWithTax: number;
  payments: Array<{ state: string; amount: number; method: string; errorMessage: string | null }>;
};
export type ShopResult = Partial<ShopOrder> & { errorCode?: string; message?: string };

// A guest Shop API session with one active order for the given customer email.
export async function guestOrder(shopClient: SimpleGraphQLClient, variantId: string, emailAddress: string) {
  await shopClient.asAnonymousUser();
  const mutate = async (document: string, variables?: Record<string, unknown>) =>
    Object.values(await shopClient.query<Record<string, ShopResult>>(parse(document), variables))[0];
  const added = await mutate(`mutation($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ${RESULT} } }`, { id: variantId });
  const customer = await mutate(`mutation($email: String!) {
    setCustomerForOrder(input: { emailAddress: $email, firstName: "S1", lastName: "Guest" }) { ${RESULT} }
  }`, { email: emailAddress });
  return {
    added, customer,
    setShipping: (id: string) => mutate(`mutation($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ${RESULT} } }`, { id: [id] }),
    arrangePayment: () => mutate(`mutation { transitionOrderToState(state: "ArrangingPayment") {
      ... on Order { ${ORDER} } ... on OrderStateTransitionError { errorCode message } } }`),
    pay: (method: string) => mutate(`mutation($method: String!) { addPaymentToOrder(input: { method: $method, metadata: {} }) {
      ${RESULT} ... on PaymentDeclinedError { paymentErrorMessage } } }`, { method }),
    eligible: () => shopClient.query<{
      eligiblePaymentMethods: Array<{ id: string; code: string; isEligible: boolean; eligibilityMessage: string | null }>;
      eligibleShippingMethods: Array<{ id: string; code: string }>;
    }>(parse(`query { eligiblePaymentMethods { id code isEligible eligibilityMessage } eligibleShippingMethods { id code } }`)),
    active: () => mutate(`query { activeOrder { ${ORDER} } }`) as Promise<ShopOrder>,
  };
}
