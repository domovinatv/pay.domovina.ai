import '@shopify/ui-extensions/preact';
import { render } from 'preact';

import { PaymentBlock } from './PaymentBlock.jsx';

export default async () => {
  render(<PaymentBlock orderId={shopify.order.value?.id} />, document.body);
};
