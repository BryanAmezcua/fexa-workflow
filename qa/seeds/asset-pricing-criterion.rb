# Idempotent fixtures + model-layer instrumentation for TANGO-65.
#
# TANGO-65 adds "Asset" as a set-criteria field on both Subcontractor (Vendor)
# and Client Product Pricing. CS escalation: Cushman & Wakefield has assets of
# the SAME TYPE at the SAME FACILITY carrying DIFFERENT contracted rates, and no
# existing criteria combination can disambiguate them.
#
# ---------------------------------------------------------------------------
# Why this seed has to manufacture the whole scenario
# ---------------------------------------------------------------------------
# Reconnaissance of fmdev before writing this seed found:
#
#   * ZERO inactive assets (52 active, 0 inactive). The AC "only active assets
#     should populate" would pass VACUOUSLY against existing data — the picker
#     would look correct simply because there is nothing for it to exclude.
#   * NO facility has two active assets of the same type. Every facility has
#     exactly one HVAC Unit. The escalation's actual scenario does not exist.
#   * ZERO product_pricings carry an asset_group_id.
#
# So the active/inactive pair, the same-type-same-facility pair, and the
# soft-deleted homonym are all created here on purpose.
#
# ---------------------------------------------------------------------------
# The asset_group_id name collision (this bit matters)
# ---------------------------------------------------------------------------
# `product_pricings.asset_group_id` stores an **ObjectAsset** id (see
# Products::ProductPricing `belongs_to :object_asset, foreign_key:
# 'asset_group_id'`), while `object_assets.asset_group_id` stores an
# **AssetGroup** (asset TEMPLATE/type) id. Same column name, two different
# meanings, and the pricings index eager-loads :object_asset — which is exactly
# what produced the PG::AmbiguousColumn 500 fixed on this branch by
# table-qualifying the grid's Asset filter (013552eb76). Every reference below
# says which one it means.
#
# ---------------------------------------------------------------------------
# What is proven here vs. in the spec
# ---------------------------------------------------------------------------
# The matching AC are numeric outcomes (which rate wins), not visual states, so
# they are proven HERE at the model layer: real `create!` calls inside
# rolled-back transactions, asserting the resolved unit_price. Results land in
# the manifest's `model_checks` block, which the spec asserts and renders.
# Nothing persists from the instrumented creates.
#
# The spec proves the GUI half: the Asset field exists in both configuration
# modals, only active assets populate the picker, an inactive asset does not
# resolve even by id, the grid Asset filter does not 500, and enforcement is
# absent on Client.
#
# Run via: npm run seed:asset-pricing-criterion

require 'json'

PREFIX = '[QA] TANGO-65'.freeze

# --- Fixed scope, all verified against fmdev before writing ------------------
FACILITY_ID         = 1     # Facilities::Facility "Pitstop 0006" — already hosts assets 1 + 2
HOMONYM_FACILITY_ID = 2     # Facilities::Facility "Pitstop 0033" — hosts the soft-deleted namesake
HVAC_GROUP_ID       = 22    # Assets::AssetGroup "HVAC Unit"  (object_assets.asset_group_id — a TEMPLATE)
SUB_ROLE_ID         = 185   # Roles::EntityRole::SubcontractorRole — vendor on invoice 23
# ClientQuoteLineItem#get_markup_and_pricing matches ClientProductPricing.role_id
# against `inv.payable_to`, which on a client quote/invoice is the
# BillToCustomerRole — NOT the facility's EndUserCustomerRole. Role 219 is
# payable_to on client invoices 154/155 and client quotes 156/157. (Pre-existing
# ClientProductPricing #9 is scoped to EndUserCustomerRole 4 and therefore could
# never match a client quote's payable_to; do not copy that shape.)
CLIENT_ROLE_ID      = 219   # Roles::EntityRole::BillToCustomerRole — payable_to on the client fixtures
SUB_INVOICE_ID      = 23    # SubcontractorInvoice, WO 122 @ facility 1

# The enforcement arm CANNOT run on invoice 23. `enforcement_reevaluatable?`
# (subcontractor_pricing_enforcement.rb:333-346) returns false once an invoice
# `in_approved_state?` or `in_completed_state?`, and invoice 23 is closed — so
# neither the enforced fill nor the mismatch rejection is evaluated there. That
# is pre-existing, invoice-state behavior, NOT anything to do with the asset
# criterion: a control run with a non-asset-scoped enforced rule on invoice 23
# behaved identically (tamper accepted). Invoice 24 is open, so enforcement is
# live there. Its vendor and facility differ from invoice 23's, hence the
# separate role + asset below.
ENF_ROLE_ID         = 183   # SubcontractorRole — vendor on invoice 24
ENF_INVOICE_ID      = 24    # SubcontractorInvoice, WO 123 @ facility 2, NOT in an approved/completed state
ENF_FACILITY_ID     = 2     # Facilities::Facility "Pitstop 0033" — invoice 24's WO facility
CLIENT_INVOICE_ID   = 154   # ClientInvoice, WO 150 @ facility 1
CLIENT_QUOTE_ID     = 156   # ClientQuote,   WO 150 @ facility 1
LABOR_PRODUCT_ID    = 2     # Products::Service "Labor" — the product on invoice 23's existing line items
EXISTING_TOILET_ASSET_ID = 1  # ObjectAsset "HQS002 Back Room Toilet" @ facility 1 — WO 122 DOES list this
EXISTING_HVAC_ASSET_ID   = 2  # ObjectAsset "BLMe1-4 Air System"     @ facility 1 — WO 122 does NOT list this
LABOR_CLASS_ID      = 1

# Rates. Deliberately distinctive so a screenshot or a manifest value is
# unambiguous about which rule won.
RATE_NORTH          = 310.0
RATE_SOUTH          = 770.0
RATE_PRODUCT_ONLY   = 120.0
RATE_ENFORCED_NORTH = 410.0
RATE_INACTIVE_ASSET = 999.0
RATE_E2_TOILET      = 211.0
RATE_E2_HVAC        = 644.0
RATE_CLIENT_NORTH   = 520.0
RATE_CLIENT_ONLY    = 200.0
RATE_GUI_ASSET      = 330.0   # browser arm, vendor 183 / asset East
RATE_GUI_ONLY       = 130.0   # browser arm, vendor 183 / no asset
# Equal-specificity precedence pair — see the PRECEDENCE note below.
RATE_PREC_ASSET     = 555.0   # asset-only rule (no product)
RATE_PREC_PRODUCT   = 111.0   # product-only rule (no asset)
# Quote/invoice CONVERSION arm (transient rules, created and rolled back).
RATE_CONV_ASSET     = 888.0   # asset-scoped client rule seen by the conversion
RATE_CONV_ONLY      = 77.0    # product-only client rule it must beat

home_currency = SSetting.get( :home_currency )

# --- Step 1: verify the scope still holds -----------------------------------
# Fail loudly rather than silently seeding into a different shape of database.

facility = Facilities::Facility.find_by( id: FACILITY_ID )
abort "Aborting: Facilities::Facility ##{FACILITY_ID} not found." unless facility

sub_role = Roles::EntityRole::SubcontractorRole.find_by( id: SUB_ROLE_ID, active: true )
abort "Aborting: active SubcontractorRole ##{SUB_ROLE_ID} not found." unless sub_role

client_role = Roles::Role.find_by( id: CLIENT_ROLE_ID, active: true )
abort "Aborting: active client Role ##{CLIENT_ROLE_ID} not found." unless client_role

sub_invoice = Invoices::SubcontractorInvoice.find_by( id: SUB_INVOICE_ID )
abort "Aborting: SubcontractorInvoice ##{SUB_INVOICE_ID} not found." unless sub_invoice

sub_wo = sub_invoice.workorders.first || sub_invoice.workorder_assignments&.first&.workorder
abort "Aborting: SubcontractorInvoice ##{SUB_INVOICE_ID} has no workorder." unless sub_wo

labor_product = Products::Product.find_by( id: LABOR_PRODUCT_ID )
abort "Aborting: Products::Product ##{LABOR_PRODUCT_ID} not found." unless labor_product

# The Edge-case #2 discriminator depends on the WO listing FEWER assets than its
# line items reference. Assert it rather than assume it — if demo data changes so
# that WO 122 lists both assets, the test stops discriminating WO-level from
# line-item-level resolution and silently becomes a tautology.
wo_asset_ids = ( sub_wo.respond_to?( :asset_group_ids ) ? Array( sub_wo.asset_group_ids ) : [] ).map( &:to_i )
e2_discriminating = wo_asset_ids.include?( EXISTING_TOILET_ASSET_ID ) &&
                    !wo_asset_ids.include?( EXISTING_HVAC_ASSET_ID )
puts "WO ##{sub_wo.id} asset_group_ids=#{wo_asset_ids.inspect} " \
     "(Edge #2 discriminating: #{e2_discriminating})"
# Hard stop rather than a warning: without this condition the Edge #2 check
# degrades into a duplicate of its own control arm and keeps passing while
# proving nothing about line-item-vs-work-order resolution.
unless e2_discriminating
  abort "Aborting: WO ##{sub_wo.id} must list ObjectAsset ##{EXISTING_TOILET_ASSET_ID} but NOT ##{EXISTING_HVAC_ASSET_ID} " \
        "at the work-order level (got #{wo_asset_ids.inspect}). Edge #2 would be a tautology."
end

# --- Step 2: clean prior TANGO-65 fixtures (idempotent) ---------------------
# Order matters: pricings reference assets, so drop pricings first.

removed_sub = Products::SubcontractorProductPricing.where( 'name LIKE ?', "#{PREFIX}%" ).destroy_all.size
removed_cli = Products::ClientProductPricing.where( 'name LIKE ?', "#{PREFIX}%" ).destroy_all.size
puts "Removed #{removed_sub} prior subcontractor + #{removed_cli} prior client fixture pricing(s)."

removed_items = Invoices::LineItem.where( 'description LIKE ?', "#{PREFIX}%" ).destroy_all.size
puts "Removed #{removed_items} prior QA line item(s)."

removed_assets = Assets::ObjectAsset.where( 'name LIKE ?', "#{PREFIX}%" ).destroy_all.size
puts "Removed #{removed_assets} prior QA asset(s)."

# --- Step 3: create the assets ----------------------------------------------
# All four are HVAC Unit (asset TEMPLATE 22) so "same type" is literally true.
# north + south sit at the SAME facility with DIFFERENT rates — that IS the
# Cushman & Wakefield escalation, reproduced.

def make_asset( name:, facility_id:, group_id:, active:, deleted: false )
  Assets::ObjectAsset.create!(
    name:            name,
    assetable_id:    facility_id,
    assetable_type:  'Facilities::Facility',
    asset_group_id:  group_id,   # NOTE: AssetGroup (template) id, not an ObjectAsset id
    active:          active,
    deleted:         deleted,
    verified:        true,
    created_by:      1,
    updated_by:      1,
  )
end

asset_north = make_asset(
  name: "#{PREFIX} Rooftop HVAC North", facility_id: FACILITY_ID,
  group_id: HVAC_GROUP_ID, active: true,
)
asset_south = make_asset(
  name: "#{PREFIX} Rooftop HVAC South", facility_id: FACILITY_ID,
  group_id: HVAC_GROUP_ID, active: true,
)
asset_inactive = make_asset(
  name: "#{PREFIX} Decommissioned HVAC", facility_id: FACILITY_ID,
  group_id: HVAC_GROUP_ID, active: false,
)
# Enforcement arm lives on invoice 24, whose workorder is at facility 2, so it
# needs its own active asset there (see the ENF_* constants for why).
asset_enforced = make_asset(
  name: "#{PREFIX} Rooftop HVAC East", facility_id: ENF_FACILITY_ID,
  group_id: HVAC_GROUP_ID, active: true,
)
# Soft-deleted namesake of asset_north. It MUST live at a different facility:
# ObjectAsset validates name uniqueness scoped to [assetable_id,
# asset_group_id] and that validation does not exclude deleted rows, so a
# same-facility namesake is not creatable. Cross-facility is also the realistic
# shape — the importer looks up by name across all assets, so this is what makes
# a bare-name lookup ambiguous unless deleted rows are excluded (5f62f47941).
asset_deleted_homonym = make_asset(
  name: "#{PREFIX} Rooftop HVAC North", facility_id: HOMONYM_FACILITY_ID,
  group_id: HVAC_GROUP_ID, active: true, deleted: true,
)

puts ''
puts "Assets (all AssetGroup #{HVAC_GROUP_ID} 'HVAC Unit'):"
[ [ asset_north, 'active, facility 1 — primary asset-scoped target' ],
  [ asset_south, 'active, facility 1 — SAME type + SAME facility, different rate (the C&W case)' ],
  [ asset_inactive, 'INACTIVE — must not populate the picker, must not resolve by id' ],
  [ asset_enforced, "active, facility #{ENF_FACILITY_ID} — enforcement arm (invoice #{ENF_INVOICE_ID} is open)" ],
  [ asset_deleted_homonym, "soft-deleted namesake of North at facility #{HOMONYM_FACILITY_ID} — importer ambiguity guard" ],
].each do |a, why|
  puts "  ##{a.id.to_s.rjust(4)} #{a.name.ljust(38)} active=#{a.active.to_s.ljust(5)} deleted=#{a.deleted} — #{why}"
end

# --- Step 4: probe products -------------------------------------------------
# Dedicated products so the matching outcome is deterministic. Reusing a demo
# product would let pre-existing pricings compete and make "which rule won"
# ambiguous.

def make_product( name:, code:, klass_id: )
  Products::Service.find_or_create_by!( name: name ) do |p|
    p.code                      = code
    p.description               = 'TANGO-65 QA probe product. Safe to delete.'
    p.product_classification_id = klass_id
    p.reorder_level             = 10
    p.reorder_quantity          = 100
    p.active                    = true
  end
end

probe_product   = make_product( name: "#{PREFIX} Asset Pricing Probe",  code: 'QT65PROBE', klass_id: LABOR_CLASS_ID )
enforced_product = make_product( name: "#{PREFIX} Enforced Asset Probe", code: 'QT65ENF',  klass_id: LABOR_CLASS_ID )
# Dedicated product for the equal-specificity precedence contest, so no
# higher-criterion-count rule can decide that match before precedence applies.
precedence_product = make_product( name: "#{PREFIX} Precedence Probe", code: 'QT65PREC', klass_id: LABOR_CLASS_ID )
puts ''
puts "Probe products: ##{probe_product.id} #{probe_product.name} / ##{enforced_product.id} #{enforced_product.name}"

# --- Step 5: create the pricings --------------------------------------------

def make_pricing( klass:, name:, role_id:, product_id:, base_price:, asset_id:, currency:, enforced: false )
  attrs = {
    name:         name,
    role_id:      role_id,
    product_id:   product_id,
    pricing_type: 'Flat Rate',   # AC Matching #4: enforcement uses flat rate + base price
    base_price:   base_price,
    active:       true,
    currency:     currency,
    # product_pricings.asset_group_id — an ObjectAsset id. nil = criterion unset.
    asset_group_id: asset_id,
  }
  # prevent_price_modification is Subcontractor-only (TANGO-4); never set it on
  # a ClientProductPricing, which is the point of AC Configuration #1's
  # sub-clause "Clients pricing would not have price enforcements".
  attrs[ :prevent_price_modification ] = enforced if klass == Products::SubcontractorProductPricing
  klass.create!( attrs )
end

sub_fixtures = []

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Asset North $#{RATE_NORTH.to_i}",
  role_id: SUB_ROLE_ID, product_id: probe_product.id, base_price: RATE_NORTH,
  asset_id: asset_north.id, currency: home_currency,
), "Asset-scoped to '#{asset_north.name}'. Drives Matching #1 (asset rule honored) and wins Matching #2 over the product-only rule." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Asset South $#{RATE_SOUTH.to_i}",
  role_id: SUB_ROLE_ID, product_id: probe_product.id, base_price: RATE_SOUTH,
  asset_id: asset_south.id, currency: home_currency,
), "Asset-scoped to '#{asset_south.name}' — same TYPE and same FACILITY as North but a different rate. This pair is the Cushman & Wakefield escalation; before TANGO-65 no criteria combination could tell them apart." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Product Only $#{RATE_PRODUCT_ONLY.to_i}",
  role_id: SUB_ROLE_ID, product_id: probe_product.id, base_price: RATE_PRODUCT_ONLY,
  asset_id: nil, currency: home_currency,
), "NO asset criterion. Drives Edge #1 (a line item with no asset still matches) and is the loser in the Matching #2 precedence contest." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Enforced Asset East $#{RATE_ENFORCED_NORTH.to_i}",
  role_id: ENF_ROLE_ID, product_id: enforced_product.id, base_price: RATE_ENFORCED_NORTH,
  asset_id: asset_enforced.id, currency: home_currency, enforced: true,
), "Asset-scoped AND enforced (prevent_price_modification=true, Flat Rate + base price). Drives Matching #4 — asset-scoped price enforcement on the subcontractor side. Scoped to vendor #{ENF_ROLE_ID} / asset '#{asset_enforced.name}' because the enforcement guard only re-evaluates on an invoice that is not approved/completed, and invoice #{SUB_INVOICE_ID} is closed." ]

# GUI arm. The browser test drives the invoice line-item form, which only
# re-resolves a unit price on an invoice that is not approved/completed — so it
# runs on invoice 24 (open, vendor 183, workorder at facility 2) rather than
# invoice 23. These two rules are the role-183 mirror of the North/product-only
# pair: with no asset the form must show $130, selecting East must re-fire the
# lookup and show $330, and CLEARING the asset must fall back to $130.
sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub GUI Asset East $#{RATE_GUI_ASSET.to_i}",
  role_id: ENF_ROLE_ID, product_id: probe_product.id, base_price: RATE_GUI_ASSET,
  asset_id: asset_enforced.id, currency: home_currency,
), "Asset-scoped, NOT enforced, on vendor #{ENF_ROLE_ID}. The browser arm's asset-scoped rate. Exercises Matching #1 in the GUI and the two preview behaviours from 156a73c676 / d026250c04. NOTE: the re-fire arm does NOT pass — selecting the asset after the product fires no lookup; see the failing browser test and observations.gui_order_dependency." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub GUI Product Only $#{RATE_GUI_ONLY.to_i}",
  role_id: ENF_ROLE_ID, product_id: probe_product.id, base_price: RATE_GUI_ONLY,
  asset_id: nil, currency: home_currency,
), "Non-asset-scoped rule on vendor #{ENF_ROLE_ID}. The browser arm's fallback rate — what must show with no asset selected, and what must come BACK when the asset field is cleared." ]

# PRECEDENCE PAIR — equal specificity, so the winner is decided by column
# precedence and nothing else.
#
# PermutationRankable orders by `total_score DESC` FIRST and only then by
# `weighted_column_score DESC` (permutation_rankable.rb:96-97). total_score is
# the COUNT of non-NULL best-match columns; weighted_column_score is the only
# place PR_BEST_MATCH_COLUMNS ORDER (i.e. precedence) is expressed.
#
# That means an asset+product rule beating a product-only rule proves nothing
# about precedence — it wins on criterion count (4 vs 3) and the sort never
# reaches the weighted score. To isolate precedence the two rules must tie on
# total_score. Both of these carry role + country + exactly ONE differentiating
# criterion, so they tie at 3 and only the column weight can separate them.
#
# Both MUST be built through make_pricing so they inherit the same `country`
# default; hand-writing one side with country: nil silently breaks the tie and
# re-confounds the test.
# The contest runs on its OWN product so no other rule can outscore it. On
# probe_product the existing asset+product rule ($310) carries 4 criteria and
# would beat both of these on total_score before precedence ever mattered.
sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Precedence AssetOnly $#{RATE_PREC_ASSET.to_i}",
  role_id: SUB_ROLE_ID, product_id: nil, base_price: RATE_PREC_ASSET,
  asset_id: asset_south.id, currency: home_currency,
), "ASSET-only rule (no product criterion), scoped to '#{asset_south.name}'. Half of the equal-specificity precedence pair: ties with the product-only rule on total_score, so if this one wins it is because asset_group_id outranks product_id in PR_BEST_MATCH_COLUMNS — the only real test of Matching #2." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Precedence ProductOnly $#{RATE_PREC_PRODUCT.to_i}",
  role_id: SUB_ROLE_ID, product_id: precedence_product.id, base_price: RATE_PREC_PRODUCT,
  asset_id: nil, currency: home_currency,
), "PRODUCT-only rule (no asset criterion) on the dedicated precedence product. The other half of the pair — same criterion count as the asset-only rule, different differentiating column." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub Inactive Asset $#{RATE_INACTIVE_ASSET.to_i}",
  role_id: SUB_ROLE_ID, product_id: probe_product.id, base_price: RATE_INACTIVE_ASSET,
  asset_id: asset_inactive.id, currency: home_currency,
), "Asset-scoped to the INACTIVE asset. Exists so the grid has a row whose asset_group_id points at an asset the picker excludes — exercises whether the by-id lookup honors the store filters (750310aeb7) rather than resolving a name the user can never re-select." ]

# Edge #2 pair, on the product that invoice 23's real line items already use.
sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub WO-Listed Asset $#{RATE_E2_TOILET.to_i}",
  role_id: SUB_ROLE_ID, product_id: labor_product.id, base_price: RATE_E2_TOILET,
  asset_id: EXISTING_TOILET_ASSET_ID, currency: home_currency,
), "Scoped to ObjectAsset ##{EXISTING_TOILET_ASSET_ID}, which WO ##{sub_wo.id} DOES list at the work-order level. Edge #2 control arm." ]

sub_fixtures << [ make_pricing(
  klass: Products::SubcontractorProductPricing, name: "#{PREFIX} Sub WO-Unlisted Asset $#{RATE_E2_HVAC.to_i}",
  role_id: SUB_ROLE_ID, product_id: labor_product.id, base_price: RATE_E2_HVAC,
  asset_id: EXISTING_HVAC_ASSET_ID, currency: home_currency,
), "Scoped to ObjectAsset ##{EXISTING_HVAC_ASSET_ID}, which WO ##{sub_wo.id} does NOT list at the work-order level, though a line item references it. Edge #2 discriminator: a line item on this asset is expected to resolve $#{RATE_E2_HVAC.to_i}, which would show matching happening at the LINE-ITEM asset rather than the work-order asset list. Result is recorded in model_checks." ]

client_fixtures = []

client_fixtures << [ make_pricing(
  klass: Products::ClientProductPricing, name: "#{PREFIX} Client Asset North $#{RATE_CLIENT_NORTH.to_i}",
  role_id: CLIENT_ROLE_ID, product_id: probe_product.id, base_price: RATE_CLIENT_NORTH,
  asset_id: asset_north.id, currency: home_currency,
), "Client-side asset-scoped rule on '#{asset_north.name}'. Proves the criterion works on BOTH pricing types (Configuration #1), not just the subcontractor side." ]

client_fixtures << [ make_pricing(
  klass: Products::ClientProductPricing, name: "#{PREFIX} Client Product Only $#{RATE_CLIENT_ONLY.to_i}",
  role_id: CLIENT_ROLE_ID, product_id: probe_product.id, base_price: RATE_CLIENT_ONLY,
  asset_id: nil, currency: home_currency,
), "Client-side rule with NO asset criterion — Edge #1 and the Matching #2 loser on the client side." ]

puts ''
puts 'Subcontractor pricings:'
sub_fixtures.each { |p, _| puts "  ##{p.id.to_s.rjust(4)} #{p.name.ljust(48)} product=#{p.product_id} asset=#{p.asset_group_id.inspect} enforce=#{p.prevent_price_modification}" }
puts 'Client pricings:'
client_fixtures.each { |p, _| puts "  ##{p.id.to_s.rjust(4)} #{p.name.ljust(48)} product=#{p.product_id} asset=#{p.asset_group_id.inspect}" }

# --- Step 6: model-layer instrumentation ------------------------------------
# Each check creates a REAL line item inside a rolled-back transaction and reads
# the unit_price the pricing engine resolved. Nothing persists.

model_checks = []

def instrumented_price( klass:, invoice_id:, product_id:, asset_id:, label: )
  result = { ok: false, unit_price: nil, error: nil, enforced: nil }
  ActiveRecord::Base.transaction do
    li = klass.new(
      description: "#{PREFIX} #{label}",
      quantity:    1,
      taxable:     false,
      tax_rate:    0,
      invoice_id:  invoice_id,
      incurred:    false,
      product_id:  product_id,
    )
    # Assign the asset the same way the line-item form does: the ObjectAsset id
    # on the line item's own asset_group_id column.
    li.asset_group_id = asset_id if li.respond_to?( :asset_group_id= )
    li.save!
    result[ :unit_price ] = li.unit_price.to_f
    result[ :enforced ]   = ( li.respond_to?( :price_enforced? ) ? li.price_enforced? : nil )
    result[ :ok ]         = true
    raise ActiveRecord::Rollback
  end
  result
rescue => e
  result[ :error ] = "#{e.class}: #{e.message}"
  result
end

def record( checks, ac:, scenario:, name:, res:, expected:, detail: )
  actual = res[ :unit_price ]
  passed = res[ :ok ] && expected && actual && ( actual - expected ).abs < 0.005
  checks << {
    ac: ac, scenario: scenario, name: name,
    unit_price: actual, expected_unit_price: expected,
    enforced: res[ :enforced ], error: res[ :error ],
    passed: !!passed,
    detail: detail + ( res[ :error ] ? " INSTRUMENTATION ERROR: #{res[:error]}" : '' ),
  }
end

SUB_LI = Invoices::SubcontractorInvoiceLineItem

# M1 + M2 — asset-scoped rule beats the product-only rule on the same product.
res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: probe_product.id,
                          asset_id: asset_north.id, label: 'M1 north' )
record( model_checks, ac: 'Matching #1, #2', scenario: 'asset_rule_honored_north',
        name: "asset-scoped rule is honored — line item on '#{asset_north.name}' resolves its asset rate, not the product-only rate",
        res: res, expected: RATE_NORTH,
        detail: "Two rules match this product for this vendor: the asset-scoped $#{RATE_NORTH.to_i} on '#{asset_north.name}' and the product-only $#{RATE_PRODUCT_ONLY.to_i}. Resolved $#{res[:unit_price].inspect}. Asset winning shows the criterion is honored (Matching #1). It does NOT by itself establish precedence: both rules share the same product_id, and the asset rule carries one MORE criterion, so it wins on total_score (criterion count) before column precedence is consulted. The precedence claim is carried by the separate precedence_equal_specificity check." )

# The escalation itself — two same-type assets at one facility, different rates.
res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: probe_product.id,
                          asset_id: asset_south.id, label: 'M1 south' )
record( model_checks, ac: 'Matching #1', scenario: 'same_type_same_facility_disambiguated',
        name: 'two assets of the SAME type at the SAME facility resolve to DIFFERENT rates (the Cushman & Wakefield case)',
        res: res, expected: RATE_SOUTH,
        detail: "'#{asset_south.name}' and '#{asset_north.name}' are both HVAC Unit assets at facility #{FACILITY_ID}. North prices at $#{RATE_NORTH.to_i}, South at $#{RATE_SOUTH.to_i}. South resolved $#{res[:unit_price].inspect}. This is the exact disambiguation the escalation asked for and that no pre-TANGO-65 criteria combination could express." )

# E1 — the criterion is optional.
res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: probe_product.id,
                          asset_id: nil, label: 'E1 no asset' )
record( model_checks, ac: 'Edge #1', scenario: 'no_asset_still_matches',
        name: 'a line item with NO asset still matches the non-asset-scoped rule',
        res: res, expected: RATE_PRODUCT_ONLY,
        detail: "Line item created with asset_group_id=nil while three asset-scoped rules exist on the same product. Resolved $#{res[:unit_price].inspect} (the product-only rule), showing the asset criterion is optional rather than required. ASSUMED (source: subcontractor_product_pricing.rb PR_FIELD_QUERIES[:asset_group_id]): the predicate is \"(asset_group_id = N OR asset_group_id IS NULL)\"." )

# E2 — resolution is per line item, not per work order.
res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: labor_product.id,
                          asset_id: EXISTING_HVAC_ASSET_ID, label: 'E2 wo-unlisted' )
record( model_checks, ac: 'Edge #2', scenario: 'line_item_level_not_wo_level',
        name: "matching resolves at the LINE-ITEM asset — an asset the work order does not list still wins",
        res: res, expected: RATE_E2_HVAC,
        detail: "WO ##{sub_wo.id} lists asset_group_ids=#{wo_asset_ids.inspect} at the work-order level, which does NOT include ObjectAsset ##{EXISTING_HVAC_ASSET_ID}. A line item referencing ##{EXISTING_HVAC_ASSET_ID} resolved $#{res[:unit_price].inspect} (expected $#{RATE_E2_HVAC.to_i}, the rule scoped to that asset) rather than $#{RATE_E2_TOILET.to_i} (the rule scoped to ##{EXISTING_TOILET_ASSET_ID}, the asset the WO DOES list). Discriminating: #{e2_discriminating}." )

res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: labor_product.id,
                          asset_id: EXISTING_TOILET_ASSET_ID, label: 'E2 wo-listed' )
record( model_checks, ac: 'Edge #2', scenario: 'line_item_level_control',
        name: 'control arm — a line item on the WO-listed asset resolves that asset\'s rate',
        res: res, expected: RATE_E2_TOILET,
        detail: "Same invoice and product, line item on ObjectAsset ##{EXISTING_TOILET_ASSET_ID} instead. Resolved $#{res[:unit_price].inspect} (expected $#{RATE_E2_TOILET.to_i}). Together with the previous check this shows the two line items on one work order price independently by their own asset." )

# M4 — asset-scoped enforcement, subcontractor side. Runs on invoice 24 (open),
# not invoice 23 (approved/completed), per the ENF_* constants.
res = instrumented_price( klass: SUB_LI, invoice_id: ENF_INVOICE_ID, product_id: enforced_product.id,
                          asset_id: asset_enforced.id, label: 'M4 enforced' )
record( model_checks, ac: 'Matching #4', scenario: 'asset_scoped_enforcement',
        name: 'asset-scoped enforcement — flat rate + base price fills the rate and reports as enforced',
        res: res, expected: RATE_ENFORCED_NORTH,
        detail: "Rule is Flat Rate, base price $#{RATE_ENFORCED_NORTH.to_i}, prevent_price_modification=true, scoped to '#{asset_enforced.name}'. On invoice ##{ENF_INVOICE_ID} the omitted unit_price filled to $#{res[:unit_price].inspect}; price_enforced?=#{res[:enforced].inspect}. Confirms enforcement composes with the new criterion on the subcontractor side — the exact combination Matching #4 names." )

# M4 negative — a mismatched price against the enforced asset rule is rejected.
# Records the enforcement gate and the post-save price so a failure is
# diagnosable rather than just "ACCEPTED".
mismatch_submitted = RATE_ENFORCED_NORTH + 55
mismatch_rejected  = false
mismatch_errors    = nil
mismatch_persisted = nil
mismatch_gate      = nil
begin
  ActiveRecord::Base.transaction do
    li = SUB_LI.new(
      description: "#{PREFIX} M4 tamper", quantity: 1, taxable: false, tax_rate: 0,
      invoice_id: ENF_INVOICE_ID, incurred: false, product_id: enforced_product.id,
      unit_price: mismatch_submitted,
    )
    li.asset_group_id = asset_enforced.id if li.respond_to?( :asset_group_id= )
    mismatch_gate     = ( li.send( :enforcement_reevaluatable? ) rescue nil )
    saved             = li.save
    mismatch_rejected = !saved
    mismatch_errors   = li.errors[ :unit_price ].join( '; ' )
    mismatch_persisted = li.unit_price.to_f
    raise ActiveRecord::Rollback
  end
rescue => e
  mismatch_errors = "#{e.class}: #{e.message}"
end
model_checks << {
  ac: 'Matching #4', scenario: 'asset_scoped_enforcement_rejects_tamper',
  name: 'asset-scoped enforcement LOCKS — a mismatched unit_price is rejected server-side',
  unit_price: nil, expected_unit_price: nil, enforced: nil, error: nil,
  submitted_price: mismatch_submitted, approved_rate: RATE_ENFORCED_NORTH,
  enforcement_reevaluatable: mismatch_gate,
  passed: mismatch_rejected,
  detail: "Submitting $#{mismatch_submitted} against the asset-scoped enforced rate $#{RATE_ENFORCED_NORTH.to_i} on invoice ##{ENF_INVOICE_ID} (no override permission — rails runner has no current_user) was #{mismatch_rejected ? 'REJECTED' : "ACCEPTED at $#{mismatch_persisted}"}#{mismatch_errors.to_s.empty? ? '' : " — errors.unit_price: #{mismatch_errors}"}. enforcement_reevaluatable?=#{mismatch_gate.inspect}. Enforcement must not weaken just because the matched rule is asset-scoped.",
}

# --- Client side -------------------------------------------------------------
# The client pricing path is NOT symmetrical with the subcontractor one, and the
# instrumentation has to respect that or it proves the wrong thing.
# ClientQuoteLineItem#get_markup_and_pricing (client_quote_line_item.rb:96-124)
# resolves the matching ClientProductPricing and records it as `pricing_id`, but
# computes unit_price from the MARKUP alone (cost + markup). The matched
# pricing's base_price never becomes the client unit_price. So the correct
# client-side assertion is WHICH PRICING MATCHED, not what rate came out —
# asserting a client unit_price would be asserting a behavior that does not
# exist.
#
# This also strengthens Kevin's merged client_quote_line_item_asset_pricing_test,
# which mocks get_pricing and only proves the asset key is PASSED. Here the
# lookup runs against real ClientProductPricing rows and we check which one wins.

def client_matched_pricing( klass:, invoice_id:, product_id:, asset_id:, facility_id: )
  result = { ok: false, pricing: nil, error: nil }
  li = klass.new(
    description: '[QA] TANGO-65 client probe', quantity: 1, taxable: false, tax_rate: 0,
    invoice_id: invoice_id, product_id: product_id, cost: 100,
  )
  li.asset_group_id = asset_id    if li.respond_to?( :asset_group_id= )
  li.facility_id    = facility_id if li.respond_to?( :facility_id= )
  _markup, pricing = li.send( :get_markup_and_pricing )
  result[ :pricing ] = pricing
  result[ :ok ]      = true
  result
rescue => e
  result[ :error ] = "#{e.class}: #{e.message}"
  result
end

client_asset_pricing  = client_fixtures[ 0 ][ 0 ]
client_only_pricing   = client_fixtures[ 1 ][ 0 ]

# Only ClientQuoteLineItem carries get_markup_and_pricing — that is where
# TANGO-65 added the client-side asset key. ClientInvoiceLineItem has no such
# method by design: client invoice line items are produced by the quote->invoice
# conversion in Invoices::Invoice (~:841-857), which TANGO-65 also updated to
# forward `source_line_item.asset_group_id` into both the payable_to and bill_to
# pricing contexts. That conversion path is NOT instrumented here — see the
# manifest's `not_instrumented` note.
[ [ Invoices::ClientQuoteLineItem, CLIENT_QUOTE_ID ] ].each do |klass, inv_id|
  short = klass.name.split( '::' ).last

  hit = client_matched_pricing( klass: klass, invoice_id: inv_id, product_id: probe_product.id,
                                asset_id: asset_north.id, facility_id: FACILITY_ID )
  matched_id = hit[ :pricing ]&.id
  model_checks << {
    ac: 'Configuration #1, Matching #1', scenario: "client_asset_rule_matched_#{short.downcase}",
    name: "client side — an asset-scoped ClientProductPricing is the match for a line item on that asset (#{short})",
    unit_price: nil, expected_unit_price: nil, enforced: nil, error: hit[ :error ],
    matched_pricing_id: matched_id,
    expected_pricing_id: client_asset_pricing.id,
    passed: matched_id == client_asset_pricing.id,
    detail: "#{short} on invoice ##{inv_id} (WO facility #{FACILITY_ID}), product ##{probe_product.id}, asset '#{asset_north.name}' (##{asset_north.id}). Two client rules compete: asset-scoped ##{client_asset_pricing.id} and product-only ##{client_only_pricing.id}. get_markup_and_pricing matched ##{matched_id.inspect} (expected ##{client_asset_pricing.id}). NOTE: the client path records the match as pricing_id and derives unit_price from the markup, not from the matched rule's base_price — so this asserts the MATCH, which is what the client side actually does.#{hit[:error] ? " ERROR: #{hit[:error]}" : ''}",
  }

  none = client_matched_pricing( klass: klass, invoice_id: inv_id, product_id: probe_product.id,
                                 asset_id: nil, facility_id: FACILITY_ID )
  none_id = none[ :pricing ]&.id
  model_checks << {
    ac: 'Edge #1', scenario: "client_no_asset_still_matches_#{short.downcase}",
    name: "client side — a line item with NO asset still matches the non-asset-scoped rule (#{short})",
    unit_price: nil, expected_unit_price: nil, enforced: nil, error: none[ :error ],
    matched_pricing_id: none_id,
    expected_pricing_id: client_only_pricing.id,
    passed: none_id == client_only_pricing.id,
    detail: "Same #{short} with asset_group_id=nil while an asset-scoped client rule exists on the same product. Matched ##{none_id.inspect} (expected the product-only ##{client_only_pricing.id}), so the asset criterion is optional on the client side too.#{none[:error] ? " ERROR: #{none[:error]}" : ''}",
  }
end

# --- Conversion path (quote -> invoice / client <-> subcontractor copy) ------
# TANGO-65 changed Invoices::Invoice#get_line_item_copy_attributes (~:841 and
# ~:854) to forward `source_line_item.asset_group_id` into BOTH pricing contexts
# used when line items are copied between documents. That is where a rate is
# committed onto a billable document, and NOTHING in the merged test suite or
# the browser suite exercises it (`grep -rn get_line_item_copy_attributes test/`
# returns nothing), so it is covered here.
#
# The copy re-prices through evaluate_data -> get_pricing, so a missing asset in
# the context would silently produce the non-asset rate on the target document.

conversion_checks_target = Invoices::ClientInvoice.find_by( id: CLIENT_INVOICE_ID )
conv_source              = Invoices::SubcontractorInvoice.find_by( id: SUB_INVOICE_ID )
conv_src_li              = conv_source&.line_items&.detect { |li| li.asset_group_id == EXISTING_HVAC_ASSET_ID }

conv_result = { ok: false, unit_price: nil, asset: nil, error: nil }
if conversion_checks_target && conv_src_li
  begin
    ActiveRecord::Base.transaction do
      # Client-side rules keyed on the TARGET's bill_to — that is the role_id the
      # conversion passes, which differs from the payable_to used by
      # ClientQuoteLineItem#get_markup_and_pricing.
      Products::ClientProductPricing.create!(
        name: "#{PREFIX} CONV Client Asset $#{RATE_CONV_ASSET.to_i}", role_id: conversion_checks_target.bill_to,
        product_id: conv_src_li.product_id, pricing_type: 'Flat Rate', base_price: RATE_CONV_ASSET,
        active: true, currency: home_currency, asset_group_id: EXISTING_HVAC_ASSET_ID )
      Products::ClientProductPricing.create!(
        name: "#{PREFIX} CONV Client ProductOnly $#{RATE_CONV_ONLY.to_i}", role_id: conversion_checks_target.bill_to,
        product_id: conv_src_li.product_id, pricing_type: 'Flat Rate', base_price: RATE_CONV_ONLY,
        active: true, currency: home_currency, asset_group_id: nil )

      conversion_checks_target.copy_line_items_from_source( conv_source, [ conv_src_li ] )
      copied = conversion_checks_target.line_items.reload.order( :id ).last
      conv_result = { ok: true, unit_price: copied.unit_price.to_f, asset: copied.asset_group_id, error: nil }
      raise ActiveRecord::Rollback
    end
  rescue ActiveRecord::Rollback
  rescue => e
    conv_result[ :error ] = "#{e.class}: #{e.message}"
  end
end

model_checks << {
  ac: 'Matching #1', scenario: 'conversion_forwards_asset_into_pricing',
  name: 'document conversion re-prices the copied line item using the SOURCE line item\'s asset',
  unit_price: conv_result[ :unit_price ], expected_unit_price: RATE_CONV_ASSET,
  enforced: nil, error: conv_result[ :error ],
  copied_asset_group_id: conv_result[ :asset ],
  passed: conv_result[ :ok ] && conv_result[ :unit_price ] &&
          ( conv_result[ :unit_price ] - RATE_CONV_ASSET ).abs < 0.005,
  detail: "Copied line item ##{conv_src_li&.id} (product ##{conv_src_li&.product_id}, asset ##{EXISTING_HVAC_ASSET_ID}) from SubcontractorInvoice ##{SUB_INVOICE_ID} into ClientInvoice ##{CLIENT_INVOICE_ID} — both work orders are at facility #{FACILITY_ID}, so the asset is retained on the copy. Two client rules competed on the target's bill_to role: asset-scoped $#{RATE_CONV_ASSET.to_i} and product-only $#{RATE_CONV_ONLY.to_i}. The copy resolved $#{conv_result[:unit_price].inspect} and carried asset_group_id=#{conv_result[:asset].inspect}. Resolving $#{RATE_CONV_ONLY.to_i} would have meant the asset was NOT forwarded into the conversion's pricing context. This path is exercised by no other test in the repo.",
}

# Cross-document, CROSS-FACILITY copy. The asset attribute is dropped by design
# (invoice.rb:798-801 — do not attach an asset the target workorder does not
# have), but the pricing context forwards it unconditionally. Recorded as an
# observation because the two halves disagree.
cross_result = { ok: false, unit_price: nil, asset: nil, error: nil }
begin
  ActiveRecord::Base.transaction do
    cross_source = Invoices::ClientInvoice.find( CLIENT_INVOICE_ID )   # WO @ facility 1
    src = Invoices::ClientInvoiceLineItem.new(
      description: "#{PREFIX} cross-facility conv source", quantity: 1, taxable: false, tax_rate: 0,
      invoice_id: cross_source.id, product_id: probe_product.id, unit_price: 1.0, cost: 1.0 )
    src.asset_group_id = asset_enforced.id                              # asset @ facility 2
    src.facility_id    = ENF_FACILITY_ID if src.respond_to?( :facility_id= )
    src.save!

    cross_target = Invoices::SubcontractorInvoice.find( ENF_INVOICE_ID ) # WO @ facility 2
    cross_target.copy_line_items_from_source( cross_source, [ src ] )
    copied = cross_target.line_items.reload.order( :id ).last
    cross_result = { ok: true, unit_price: copied.unit_price.to_f, asset: copied.asset_group_id, error: nil }
    raise ActiveRecord::Rollback
  end
rescue ActiveRecord::Rollback
rescue => e
  cross_result[ :error ] = "#{e.class}: #{e.message}"
end

# --- Step 7: precedence position (answers the ticket's open question) --------
# The ticket asks "Where does Asset sit in the best-match precedence order
# (most-specific vs. mid)? [Owner: eng]". PR_BEST_MATCH_COLUMNS is ordered
# most-significant-first, so read the answer straight off the constant.

precedence = {}
{ subcontractor: Products::SubcontractorProductPricing,
  client:        Products::ClientProductPricing }.each do |k, klass|
  cols = klass::PR_BEST_MATCH_COLUMNS
  precedence[ k ] = {
    asset_index:   cols.index( :asset_group_id ),
    product_index: cols.index( :product_id ),
    total_columns: cols.length,
    asset_outranks_product: cols.index( :asset_group_id ) < cols.index( :product_id ),
    columns_in_order: cols.map( &:to_s ),
  }
end

model_checks << {
  ac: 'Matching #2', scenario: 'defined_precedence',
  name: 'Asset has a DEFINED position in PR_BEST_MATCH_COLUMNS (structural read, not a behavioral observation)',
  unit_price: nil, expected_unit_price: nil, enforced: nil, error: nil,
  passed: precedence[ :subcontractor ][ :asset_outranks_product ] &&
          precedence[ :client ][ :asset_outranks_product ],
  detail: "asset_group_id is at index #{precedence[:subcontractor][:asset_index]} of #{precedence[:subcontractor][:total_columns]} in SubcontractorProductPricing::PR_BEST_MATCH_COLUMNS and index #{precedence[:client][:asset_index]} of #{precedence[:client][:total_columns]} in ClientProductPricing::PR_BEST_MATCH_COLUMNS — position 0 in both, ahead of product_id (index #{precedence[:subcontractor][:product_index]}). SCOPE OF THIS CHECK: it reads the constant, so it is evidence about source, not behavior. Column order feeds `weighted_column_score`, which PermutationRankable consults ONLY as a tiebreaker — the ranking sorts by `total_score DESC` (the COUNT of non-NULL criteria) FIRST (permutation_rankable.rb:96-97). The behavioral proof that the column order actually decides an equal-specificity match is the separate `precedence_equal_specificity` check.",
}

# The real Matching #2 evidence: two rules that TIE on criterion count, so the
# winner can only be decided by PR_BEST_MATCH_COLUMNS order.
res = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: precedence_product.id,
                          asset_id: asset_south.id, label: 'M2 equal specificity' )
record( model_checks, ac: 'Matching #2', scenario: 'precedence_equal_specificity',
        name: 'at EQUAL specificity, the asset-scoped rule outranks the product-scoped rule',
        res: res, expected: RATE_PREC_ASSET,
        detail: "Two competing rules with the SAME criterion count (each carries role + country + one differentiating column, total_score 3): an asset-only rule at $#{RATE_PREC_ASSET.to_i} scoped to '#{asset_south.name}', and a product-only rule at $#{RATE_PREC_PRODUCT.to_i} scoped to '#{precedence_product.name}'. A line item carrying BOTH resolved $#{res[:unit_price].inspect}. Because total_score ties, the ranking falls through to weighted_column_score, so this outcome is decided purely by asset_group_id's position in PR_BEST_MATCH_COLUMNS. Unlike the asset+product vs product-only contest — which the asset rule wins on criterion COUNT regardless of column order — this one would flip if asset_group_id were moved after product_id. FLAG FOR SIGN-OFF: if CS expected Product to win an equally-specific Product-vs-Asset conflict, that expectation is not met.",
)

# --- Observed behavior, NOT an AC assertion ---------------------------------
# The AC governs which assets POPULATE THE PICKER. It says nothing about what
# happens to a rule already bound to an asset that is later deactivated.
# PR_FIELD_QUERIES[:asset_group_id] matches on the bare id — there is no join to
# object_assets and no active/deleted predicate — so such a rule keeps winning.
# Recorded for a product decision; deliberately not asserted as pass/fail.
inactive_match = instrumented_price( klass: SUB_LI, invoice_id: SUB_INVOICE_ID, product_id: probe_product.id,
                                     asset_id: asset_inactive.id, label: 'inactive asset match' )

# --- Step 7b: impact probe for the GUI order-dependency defect ---------------
# The browser arm found that selecting the asset AFTER the product does not
# re-resolve the previewed rate (no get_unit_price request fires), so the form
# submits the already-populated non-asset rate. This records what the SERVER then
# persists in that exact situation. It is an OBSERVATION, not an AC pass/fail —
# the server behaves correctly given its inputs; the defect is that the GUI sends
# the wrong input.

stale_persisted = nil
correct_persisted = nil
begin
  ActiveRecord::Base.transaction do
    li = SUB_LI.new(
      description: "#{PREFIX} stale-rate probe", quantity: 1, taxable: false, tax_rate: 0,
      invoice_id: ENF_INVOICE_ID, incurred: false, product_id: probe_product.id,
      unit_price: RATE_GUI_ONLY,     # what the GUI leaves in the field
    )
    li.asset_group_id = asset_enforced.id
    li.save!
    stale_persisted = li.unit_price.to_f
    raise ActiveRecord::Rollback
  end
rescue => e
  stale_persisted = "ERROR #{e.class}"
end

begin
  ActiveRecord::Base.transaction do
    li = SUB_LI.new(
      description: "#{PREFIX} correct-rate probe", quantity: 1, taxable: false, tax_rate: 0,
      invoice_id: ENF_INVOICE_ID, incurred: false, product_id: probe_product.id,
    )
    li.asset_group_id = asset_enforced.id
    li.save!
    correct_persisted = li.unit_price.to_f
    raise ActiveRecord::Rollback
  end
rescue => e
  correct_persisted = "ERROR #{e.class}"
end

# Does the invoice line-item asset picker exclude soft-deleted assets? The
# TANGO-65 AC is about the PRICING modal's asset list, but the line-item picker
# is the other place an asset is chosen, so record what it would offer.
line_item_picker_assets = Assets::ObjectAsset
  .where( assetable_id: ENF_FACILITY_ID, assetable_type: 'Facilities::Facility' )
  .map { |a| { id: a.id, name: a.name, active: a.active, deleted: a.deleted } }

observations = {
  conversion_prices_by_an_asset_it_then_drops: {
    summary: 'On a CROSS-FACILITY document copy the line item is priced using the source asset, but the asset attribute is then dropped from the copy — so the target line carries an asset-derived rate with no asset on it.',
    copied_unit_price: cross_result[ :unit_price ],
    copied_asset_group_id: cross_result[ :asset ],
    asset_scoped_rate: RATE_GUI_ASSET,
    non_asset_fallback_rate: RATE_GUI_ONLY,
    error: cross_result[ :error ],
    mechanism: 'get_line_item_copy_attributes forwards source_line_item.asset_group_id into the pricing context UNCONDITIONALLY (invoice.rb ~:841 / ~:854, added by TANGO-65), while the asset_group_id ATTRIBUTE is removed from the copyable set unless the target workorder has that asset or the facilities match (invoice.rb:798-801, pre-existing). The two halves disagree.',
    why_it_matters: 'Before TANGO-65 a cross-facility copy priced at the non-asset rate and carried no asset — self-consistent. Now it prices at the asset rate and still carries no asset, so the charge cannot be attributed to the asset that produced it. Either both halves should be gated or neither.',
  },
  inactive_asset_still_matches: {
    summary: 'A pricing rule bound to an asset that is later DEACTIVATED still wins at match time. Observed behavior, outside the AC — recorded for a product decision, not asserted as pass/fail.',
    asset: { id: asset_inactive.id, name: asset_inactive.name, active: asset_inactive.active, deleted: asset_inactive.deleted },
    inactive_asset_rule_rate: RATE_INACTIVE_ASSET,
    non_asset_fallback_rate: RATE_PRODUCT_ONLY,
    resolved_unit_price: inactive_match[ :unit_price ],
    error: inactive_match[ :error ],
    mechanism: 'PR_FIELD_QUERIES[:asset_group_id] matches on the bare ObjectAsset id — no join to object_assets, no active/deleted predicate. The AC\'s "only active assets" is enforced at SELECTION time (the two Ext store filters and the import parser scope), never at MATCH time.',
    why_it_matters: 'The escalation is about per-asset contracted rates on equipment that gets decommissioned. Whether a rule should keep pricing against a deactivated asset needs a product answer; today there is no defined behavior either way.',
  },
  gui_order_dependency: {
    summary: 'Selecting the asset AFTER the product does not re-resolve the previewed rate; selecting it BEFORE the product does.',
    submitted_stale_unit_price: RATE_GUI_ONLY,
    persisted_when_stale_submitted: stale_persisted,
    persisted_when_unit_price_omitted: correct_persisted,
    contracted_asset_rate: RATE_GUI_ASSET,
    impact: "A line item saved through the product-then-asset flow persists $#{stale_persisted} instead of the contracted asset rate $#{RATE_GUI_ASSET.to_i}. The server is correct in isolation — omitting unit_price resolves $#{correct_persisted} — because set_unit_price only fills a BLANK unit_price. The wrong value comes from the form.",
  },
  line_item_asset_picker_contents: {
    facility_id: ENF_FACILITY_ID,
    assets: line_item_picker_assets,
    note: 'Observation only, outside the TANGO-65 AC: the invoice line-item asset picker is a different component from the pricing configuration modal. Recorded because a soft-deleted asset at this facility would still be offered there.',
  },
}

# --- Step 8: emit manifest --------------------------------------------------

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-65.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

asset_rows = [
  [ asset_north,           'active', 'Primary asset-scoped target. Both a subcontractor rule ($%d) and a client rule ($%d) are scoped to it.' % [ RATE_NORTH, RATE_CLIENT_NORTH ] ],
  [ asset_south,           'active', 'Same asset TYPE (HVAC Unit) at the same facility as North but priced at $%d instead of $%d — reproduces the Cushman & Wakefield scenario. (That no pre-TANGO-65 criteria combination could disambiguate these is the ticket premise; this suite does not test pre-change behaviour.)' % [ RATE_SOUTH, RATE_NORTH ] ],
  [ asset_inactive,        'inactive', 'Must NOT appear in either asset picker (Configuration #2) and must NOT resolve a display name on a by-id lookup.' ],
  [ asset_enforced,        'active', 'At facility %d, invoice %d\'s workorder facility. Hosts the enforced asset-scoped rule, because the enforcement guard does not re-evaluate on the approved/completed invoice %d.' % [ ENF_FACILITY_ID, ENF_INVOICE_ID, SUB_INVOICE_ID ] ],
  [ asset_deleted_homonym, 'soft-deleted', 'Shares North\'s name at a different facility. Makes a bare-name import lookup ambiguous unless deleted rows are excluded.' ],
]

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-65',
  source_seed:  'seeds/asset-pricing-criterion.rb',
  description:  'Fixtures and model-layer instrumentation for Asset as a product-pricing set-criteria field. Manufactures the escalation scenario absent from fmdev (two same-type assets at one facility with different rates, plus an inactive asset and a soft-deleted namesake), creates asset-scoped and non-asset-scoped rules on BOTH the subcontractor and client sides, and RECORDS the matching outcomes numerically via real line-item creates inside rolled-back transactions (results in model_checks).',
  scope: {
    facility:        { id: facility.id, name: facility.name },
    homonym_facility_id: HOMONYM_FACILITY_ID,
    asset_group:     { id: HVAC_GROUP_ID, name: 'HVAC Unit', note: 'object_assets.asset_group_id — an AssetGroup TEMPLATE id, not an ObjectAsset id' },
    subcontractor:   { role_id: SUB_ROLE_ID, invoice_id: SUB_INVOICE_ID, workorder_id: sub_wo.id },
    client:          { role_id: CLIENT_ROLE_ID, invoice_id: CLIENT_INVOICE_ID, quote_id: CLIENT_QUOTE_ID },
    products:        { probe: { id: probe_product.id, name: probe_product.name },
                       enforced: { id: enforced_product.id, name: enforced_product.name },
                       labor: { id: labor_product.id, name: labor_product.name } },
    assets:          asset_rows.map { |a, state, why| { id: a.id, name: a.name, state: state, facility_id: a.assetable_id, asset_group_id: a.asset_group_id, active: a.active, deleted: a.deleted, purpose: why } },
    workorder_asset_ids: wo_asset_ids,
    edge2_discriminating: e2_discriminating,
    rates: {
      asset_north: RATE_NORTH, asset_south: RATE_SOUTH, product_only: RATE_PRODUCT_ONLY,
      enforced_north: RATE_ENFORCED_NORTH, inactive_asset: RATE_INACTIVE_ASSET,
      wo_listed_asset: RATE_E2_TOILET, wo_unlisted_asset: RATE_E2_HVAC,
      client_asset_north: RATE_CLIENT_NORTH, client_product_only: RATE_CLIENT_ONLY,
      gui_asset_east: RATE_GUI_ASSET, gui_product_only: RATE_GUI_ONLY,
    },
    gui_arm: {
      invoice_id: ENF_INVOICE_ID, role_id: ENF_ROLE_ID, facility_id: ENF_FACILITY_ID,
      product_id: probe_product.id, asset_id: asset_enforced.id,
      asset_rate: RATE_GUI_ASSET, fallback_rate: RATE_GUI_ONLY,
      enforced_product_id: enforced_product.id, enforced_rate: RATE_ENFORCED_NORTH,
      note: 'The browser arm runs on invoice %d because the line-item form only re-resolves a price on an invoice that is not approved/completed; invoice %d is closed.' % [ ENF_INVOICE_ID, SUB_INVOICE_ID ],
    },
    precedence: precedence,
    column_name_collision: 'product_pricings.asset_group_id holds an ObjectAsset id; object_assets.asset_group_id holds an AssetGroup (template) id. The pricings index eager-loads :object_asset, so an unqualified filter on that name raises PG::AmbiguousColumn — the 500 fixed by 013552eb76.',
    not_in_scope: 'Duplicate-warning extension (extend to client pricings; flag when the asset already has another active pricing) is explicitly out of scope per the ticket and is not exercised.',
    not_instrumented: 'The quote->invoice conversion path in Invoices::Invoice (~:841-857), which TANGO-65 updated to forward source_line_item.asset_group_id into both the payable_to and bill_to pricing contexts, is not covered by these model checks. Client-side coverage here is ClientQuoteLineItem#get_markup_and_pricing only.',
    client_role_note: 'ClientProductPricing.role_id is matched against inv.payable_to, which on a client quote/invoice is a BillToCustomerRole (219 here), not the facility EndUserCustomerRole. A client pricing scoped to an EndUserCustomerRole never matches a client quote.',
  },
  fixtures: ( sub_fixtures + client_fixtures ).map do |rec, purpose|
    {
      id:                         rec.id,
      name:                       rec.name,
      active:                     rec.active,
      product_id:                 rec.product_id,
      pricing_type:               rec.pricing_type,
      base_price:                 rec.base_price.to_s,
      asset_group_id:             rec.asset_group_id,
      asset_name:                 rec.asset_group_id ? Assets::ObjectAsset.find_by( id: rec.asset_group_id )&.name : nil,
      role_id:                    rec.role_id,
      kind:                       rec.class.name.split( '::' ).last,
      prevent_price_modification: ( rec.respond_to?( :prevent_price_modification ) ? !!rec.prevent_price_modification : nil ),
      facility_id:                rec.facility_id,
      effective_start_date:       ( rec.respond_to?( :effective_start_date ) ? rec.effective_start_date&.iso8601 : nil ),
      effective_end_date:         ( rec.respond_to?( :effective_end_date ) ? rec.effective_end_date&.iso8601 : nil ),
      purpose:                    purpose,
    }
  end,
  assets: asset_rows.map { |a, state, why| { id: a.id, name: a.name, state: state, facility_id: a.assetable_id, active: a.active, deleted: a.deleted, purpose: why } },
  model_checks: model_checks,
  observations: observations,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-65 model checks (resolved unit_price per instrumented create) ---'
model_checks.each do |c|
  status = c[ :passed ] ? 'PASS' : 'FAIL'
  extra  = c[ :unit_price ] ? "resolved=$#{c[:unit_price]} (exp $#{c[:expected_unit_price]})" : ''
  puts "  [#{status}] #{c[:ac]} — #{c[:scenario]} #{extra}"
  puts "           #{c[:error]}" if c[ :error ]
end
puts ''
puts "Facility:  ##{facility.id} #{facility.name}   WO ##{sub_wo.id} asset_group_ids=#{wo_asset_ids.inspect}"
puts "Precedence: asset_group_id index #{precedence[:subcontractor][:asset_index]} (sub) / #{precedence[:client][:asset_index]} (client) — product_id at #{precedence[:subcontractor][:product_index]}"
puts "Manifest:  #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:asset-pricing-criterion"
