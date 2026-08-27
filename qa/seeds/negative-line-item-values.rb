# Idempotent test fixtures for the negative line item values scenarios (TANGO-111).
#
# Scope note: TANGO-111's description AC describes the ORIGINAL request (expose
# line item / classification totals as workflow data points). That was deferred
# and re-scoped; the agreed behavior lives in the ticket comments — a site
# setting, `allow_negative_line_item_values`, defaulting to TRUE (allow), which
# when set to FALSE blocks saving a line item whose total (quantity * unit_price)
# is not greater than zero.
#
# Run via: npm run seed:negative-line-item-values
#
# What this seed provisions:
#   1. The site setting itself, reset to TRUE (allow) so every run starts from
#      the shipped default. The spec flips it to FALSE via the admin API.
#   2. A NEGATIVE line item on vendor invoice 26, created while the setting is
#      still TRUE. This is the "already existed before the customer opted in"
#      row that drives the grandfathering clause and acts as the source row for
#      the duplication clause. Seeding it with the setting ON (rather than with
#      the model's bypass flag) mirrors the real customer story.
#   3. A positive line item alongside it, so a duplication run has something
#      that MUST copy while the negative one must be skipped.
#
# Existing dev-DB fixtures this seed relies on (all verified Draft / New, so
# admin may edit them):
#   - SubcontractorInvoice 26 — WO 125, Assignment 131 — copy SOURCE
#   - SubcontractorInvoice 28 — WO 127, Assignment 133 — copy TARGET (starts empty)
#   - ClientQuote           156 — WO-linked — client-side create/block scenario

require 'json'

SETTING_NAME     = 'allow_negative_line_item_values'.freeze
FIXTURE_PREFIX   = '[QA] TANGO-111'.freeze
SOURCE_INVOICE_ID = 26
TARGET_INVOICE_ID = 28
CLIENT_QUOTE_ID   = 156
MANIFEST_PATH     = File.join( ENV['OLDPWD'].to_s, 'reports', 'seed-manifest-tango-111.json' )

# --- Step 1: the site setting -----------------------------------------------
# Reset to the shipped default (true = allow) on every run so a previous run
# that left it false can never make the next run's "setting ON" case a false
# positive.

setting = Administration::SiteSetting.find_or_initialize_by( name: SETTING_NAME )
setting.value_type      = 'boolean'
setting.value           = true
setting.send_to_gui     = true
setting.feature_grouping = 'Invoicing'
setting.save!

abort "Aborting: #{SETTING_NAME} did not persist as a real boolean true." unless setting.reload.typed_value == true
puts "Site setting #{SETTING_NAME} = #{setting.typed_value.inspect} (id=#{setting.id})"

# --- Step 2: resolve the invoices -------------------------------------------

source_invoice = Invoices::SubcontractorInvoice.find_by( id: SOURCE_INVOICE_ID )
abort "Aborting: SubcontractorInvoice #{SOURCE_INVOICE_ID} not found." unless source_invoice

target_invoice = Invoices::SubcontractorInvoice.find_by( id: TARGET_INVOICE_ID )
abort "Aborting: SubcontractorInvoice #{TARGET_INVOICE_ID} not found." unless target_invoice

client_quote = Invoices::ClientQuote.find_by( id: CLIENT_QUOTE_ID )
abort "Aborting: ClientQuote #{CLIENT_QUOTE_ID} not found." unless client_quote

[ source_invoice, target_invoice, client_quote ].each do |inv|
  next if inv.allow_user_editing?
  abort "Aborting: #{inv.class.name} #{inv.id} is not user-editable in its current state."
end

# --- Step 3: clean prior fixtures -------------------------------------------
# Match on the description prefix so re-running never stacks duplicates, and so
# nothing outside this ticket's fixtures is ever touched.

removed = Invoices::LineItem.where( 'description LIKE ?', "#{FIXTURE_PREFIX}%" ).destroy_all.size
puts "Removed #{removed} prior fixture line item(s)."

# Return the copy target to empty so the duplication scenario always starts from
# a known-clean slate.
cleared = target_invoice.line_items.count
target_invoice.line_items.destroy_all
puts "Cleared #{cleared} line item(s) from copy target invoice #{TARGET_INVOICE_ID}."

# --- Step 4: pick a product -------------------------------------------------
# Reuse whatever product the source invoice already uses so classification and
# pricing behave exactly as they do for the invoice's existing rows.

product = source_invoice.line_items.first&.product
product ||= Products::Product.joins( :product_classification ).first
abort 'Aborting: no usable product found.' unless product

facility_id = source_invoice.line_items.first&.facility_id || source_invoice.workorders.first&.facility_id
abort 'Aborting: could not resolve a facility for the fixture line items.' unless facility_id

# --- Step 5: build the fixture line items -----------------------------------
# NOTE: the setting is TRUE at this point (step 1), so the negative row is
# created through the ordinary validated path — no bypass flag. That is the
# whole point: it proves a negative line CAN be created while the site allows
# it, and it produces a genuine pre-existing row for the grandfather clause.

specs = [
  {
    invoice:     source_invoice,
    klass:       Invoices::SubcontractorInvoiceLineItem,
    description: "#{FIXTURE_PREFIX} negative credit line",
    quantity:    1,
    unit_price:  -25,
    purpose:     'Pre-existing NEGATIVE line, created while the setting still allowed it. Drives the grandfathering clause (editing an unrelated field must still save) and is the row duplication must SKIP.',
  },
  {
    invoice:     source_invoice,
    klass:       Invoices::SubcontractorInvoiceLineItem,
    description: "#{FIXTURE_PREFIX} positive companion line",
    quantity:    2,
    unit_price:  40,
    purpose:     'Positive line on the same invoice. Duplication must COPY this one, proving the copy is partial rather than wholesale-blocked.',
  },
]

created = specs.map do |spec|
  purpose = spec.delete( :purpose )
  invoice = spec.delete( :invoice )
  klass   = spec.delete( :klass )

  rec = klass.new( spec.merge(
    invoice_id:  invoice.id,
    product_id:  product.id,
    facility_id: facility_id,
    taxable:     false,
    tax_rate:    0,
  ) )

  unless rec.save
    abort "Aborting: failed to create '#{spec[:description]}' — #{rec.errors.full_messages.join( '; ' )}"
  end

  [ rec, purpose ]
end

# --- Step 6: verify the seed actually did what it claims --------------------

negative = created.find { |rec, _| rec.quantity * rec.unit_price < 0 }&.first
abort 'Aborting: the negative fixture line item was not created.' unless negative&.persisted?

# --- Step 7: emit manifest --------------------------------------------------

manifest = {
  ticket:       'TANGO-111',
  source_seed:  'seeds/negative-line-item-values.rb',
  generated_at: Time.current.iso8601,
  scope: {
    setting: {
      id:    setting.id,
      name:  setting.name,
      value: setting.typed_value,
      note:  'Reset to true (allow) on every seed run; the spec flips it to false via PUT /api/v1/site_settings/:id.',
    },
    source_invoice_id: source_invoice.id,
    target_invoice_id: target_invoice.id,
    client_quote_id:   client_quote.id,
    product: { id: product.id, name: product.name, classification_id: product.product_classification_id },
    facility_id: facility_id,
  },
  fixtures: created.map do |rec, purpose|
    {
      id:          rec.id,
      type:        rec.type,
      invoice_id:  rec.invoice_id,
      description: rec.description,
      quantity:    rec.quantity.to_s,
      unit_price:  rec.unit_price.to_s,
      line_total:  ( rec.quantity * rec.unit_price ).to_s,
      purpose:     purpose,
    }
  end,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-111 fixtures ---'
puts "Setting:       #{setting.name} = #{setting.typed_value.inspect} (default/allow)"
puts "Copy source:   SubcontractorInvoice #{source_invoice.id}"
puts "Copy target:   SubcontractorInvoice #{target_invoice.id} (emptied)"
puts "Client quote:  ClientQuote #{client_quote.id}"
puts "Product:       #{product.name} (id=#{product.id})"
puts ''
created.each do |rec, _purpose|
  puts "  [#{rec.id.to_s.rjust( 6 )}] #{rec.description}  qty=#{rec.quantity} rate=#{rec.unit_price}  total=#{( rec.quantity * rec.unit_price ).to_f}"
end
puts ''
puts "Manifest:  #{MANIFEST_PATH}"
puts 'Re-run safely with: npm run seed:negative-line-item-values'
