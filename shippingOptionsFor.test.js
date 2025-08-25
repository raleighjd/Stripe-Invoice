const { shippingOptionsFor } = require('./server');

describe('shippingOptionsFor', () => {
  test('US orders under $100 have $10 standard shipping', () => {
    const options = shippingOptionsFor(5000, { country: 'US' });
    expect(options[0].shipping_rate_data.fixed_amount.amount).toBe(1000);
  });

  test('US orders $100 or more get free standard shipping', () => {
    const options = shippingOptionsFor(15000, { country: 'US' });
    expect(options[0].shipping_rate_data.fixed_amount.amount).toBe(0);
  });

  test('International orders use international rates', () => {
    const options = shippingOptionsFor(5000, { country: 'CA' });
    expect(options[0].shipping_rate_data.display_name).toBe('Standard (Intl.)');
  });
});
