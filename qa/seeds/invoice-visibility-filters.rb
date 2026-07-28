# Idempotent test fixtures for TANGO-86 — "Hidden invoice/proposal permissions
# bypass via direct link access".
#
# The merged fix (PR #7110 + follow-up 34b03ef84a) makes the four invoice/quote
# show actions load through accessible_by(current_ability).eager_load([...])
# .find(params[:id]) + an explicit authorize! :show, so SQL-string permission
# filters (Permissions::Resource#sql_string) that already hid records from
# grids now also block direct-link show.
#
# The admin Playwright persona is a super_admin whose ability overrides
# enforcement, so this seed stands up dedicated restricted users + Doorkeeper
# bearer tokens (TANGO-49 pattern) that the spec uses to observe the denials
# over live HTTP, plus accessible_by model checks recorded in the manifest
# (TANGO-35/49 pattern) that prove the fixtures actually hide at the ability
# layer before any HTTP test runs.
#
# Fixtures per affected class (SubcontractorInvoice, SubcontractorQuote,
# ClientInvoice, ClientQuote — all sharing the STI `invoices` table):
#   - a HIDDEN record (excluded by the filtered user's sql_string)
#   - a VISIBLE sibling (proves the filter discriminates, unlike the merged
#     minitest's degenerate '1=0'/'1=1' strings)
#   - a payload_probe id (existing association-rich record, admin read-only)
#
# Users:
#   - filtered     read on all 4 classes with sql_string 'invoices.id NOT IN
#                  (<the 4 hidden ids>)'  -> hidden = missing_record, visible = 200
#   - noread       read on an unrelated class only -> 401 (class-level authorize)
#   - instancerule read on all 4 classes with a DENYING instance_methods rule
#                  (total < 0; totals recalc to >= 0) -> 401 (the 34b03ef84a guard)
#   - joinsql      single grant with a JOIN-REFERENCING sql_string (stores.*) —
#                  model-check only (info): documents index-vs-show divergence
#                  when a filter names a table only the show eager_load joins.
#
# Run via: npm run seed:invoice-visibility-filters

require 'json'
require 'fileutils'

FIXTURE_PREFIX = '[QA-TANGO86] '.freeze
GROUP_PREFIX   = '[QA] TANGO-86'.freeze
QA_PASSWORD    = 'qa-tango-86-pass1'.freeze
ADMIN_EMAIL    = 'bigbrother@fexa.io'.freeze

CLASSES = {
  subcontractor_invoice: Invoices::SubcontractorInvoice,
  subcontractor_quote:   Invoices::SubcontractorQuote,
  client_invoice:        Invoices::ClientInvoice,
  client_quote:          Invoices::ClientQuote,
}.freeze

ENDPOINTS = {
  subcontractor_invoice: '/api/v1/subcontractor_invoices',
  subcontractor_quote:   '/api/v1/subcontractor_quotes',
  client_invoice:        '/api/v1/client_invoices',
  client_quote:          '/api/v1/client_quotes',
}.freeze

def banner(msg); puts "\n=== #{msg} ==="; end
def assert(cond, msg)
  raise "ASSERTION FAILED: #{msg}" unless cond
  puts "  ok: #{msg}"
end

# --- Step 0: bootstrap -------------------------------------------------------

admin_user = User.find_by(email: ADMIN_EMAIL)
abort "Aborting: admin user '#{ADMIN_EMAIL}' missing." unless admin_user
org_id = admin_user.organization_id
abort 'Aborting: admin user has no organization.' unless org_id

ref_group = Permissions::Group.find_by(name: 'Corporate User - Level 1') ||
            Permissions::Group.where.not(role_type: nil).first
ref_role_type = ref_group&.role_type

# --- Step 1: clean prior fixtures (idempotent) -------------------------------

banner 'Cleaning prior TANGO-86 fixtures'
CLASSES.each_value do |klass|
  n = klass.where('reference_number LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size
  puts "  removed #{n} #{klass.name}"
end
Doorkeeper::AccessToken.where(application_id: Doorkeeper::Application.where('name LIKE ?', "#{FIXTURE_PREFIX}%").select(:id)).delete_all
puts "  removed #{Doorkeeper::Application.where('name LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size} oauth application(s)"

# --- Step 2: templates + hidden/visible pair per class -----------------------
# Reuse an existing record's bill_to/payable_to so FKs are valid and the
# serializer's role lookups (is_expeditable etc.) resolve. The template id
# doubles as the admin payload probe (association-rich, read-only).

banner 'Creating hidden/visible fixture pairs'
stamp    = Time.now.to_i
fixtures = {}

# The dev DB has ZERO client invoices/quotes and no BillToCustomerRole, so the
# client classes get their own idempotent scaffolding (mirrors the merged
# minitest setup): billable org with term + default billing address +
# BillToCustomerRole, a payable org + role, linked to an existing workorder.
banner 'Client scaffolding (billable/payable orgs + roles)'
billable_term = Invoices::SubcontractorPaymentTerm.find_by(name: "#{FIXTURE_PREFIX}Bill To Within 30") ||
                Invoices::SubcontractorPaymentTerm.create!(name: "#{FIXTURE_PREFIX}Bill To Within 30", due_days: 30, active: true)
payable_term  = Invoices::SubcontractorPaymentTerm.find_by(name: "#{FIXTURE_PREFIX}Payable Term") ||
                Invoices::SubcontractorPaymentTerm.create!(name: "#{FIXTURE_PREFIX}Payable Term", due_days: 30, active: true)
billable_org  = Entities::Organization.find_by(term_id: billable_term.id) || Entities::Organization.create!(term_id: billable_term.id)
payable_org   = Entities::Organization.find_by(term_id: payable_term.id)  || Entities::Organization.create!(term_id: payable_term.id)
# BOTH orgs need default addresses of BOTH types: the client-invoice index
# INNER JOINs a default BillingAddress for payable AND billable roles
# (client_invoice.rb:270-278); the client-quote index INNER JOINs a default
# GeneralAddress for both (client_quote.rb:166-175).
{ billable_org => "#{FIXTURE_PREFIX}Client Org", payable_org => "#{FIXTURE_PREFIX}Payable Org" }.each do |org, company|
  [Addresses::BillingAddress, Addresses::GeneralAddress].each do |addr_klass|
    # Exact-type lookup: STI parent scopes include descendants, so a plain
    # GeneralAddress.find_by would match the BillingAddress and skip creation.
    addr_klass.where(entity_id: org.id, type: addr_klass.name).first || addr_klass.create!(
      company: company, address1: '1 QA Way', city: 'Haddon Heights', state: 'NJ',
      postal_code: '08035', country: 'US', phone: '555-555-5555', default_address: true, entity_id: org.id,
    )
  end
end
billable_role = Roles::EntityRole::BillToCustomerRole.where(active: true).detect { |r| r.organization&.id == billable_org.id } ||
                Roles::EntityRole::BillToCustomerRole.create!(start_date: Time.now, active: true, organization: billable_org)
payable_role  = Roles::EntityRole::BillToCustomerRole.where(active: true).detect { |r| r.organization&.id == payable_org.id } ||
                Roles::EntityRole::BillToCustomerRole.create!(start_date: Time.now, active: true, organization: payable_org)
linked_wo = Workorders::Workorder.order(id: :desc).first
abort 'Aborting: no workorder exists to link client invoices to.' unless linked_wo
puts "  billable_role=#{billable_role.id} payable_role=#{payable_role.id} linked_wo=#{linked_wo.id}"

CLASSES.each do |key, klass|
  client_class = [Invoices::ClientInvoice, Invoices::ClientQuote].include?(klass)

  if client_class
    base_attrs = {
      transaction_date: Date.current,
      due_date:         Date.current,
      bill_to:          billable_role.id,
      payable_to:       payable_role.id,
      object_invoices_attributes: [{ invoiceable_id: linked_wo.id, invoiceable_type: 'Workorders::Workorder' }],
    }
    payload_probe_id = nil   # filled below — no pre-existing client records in this DB
  else
    needs_assignment = klass == Invoices::SubcontractorInvoice   # verify_assignment validation
    template = klass.order(id: :desc).limit(200).detect do |rec|
      rec.bill_to.present? && Roles::Role.exists?(id: rec.bill_to) &&
        (rec.payable_to.blank? || Roles::Role.exists?(id: rec.payable_to)) &&
        (!needs_assignment || rec.workorder_assignments.first.present?)
    end
    abort "Aborting: no usable template #{klass.name} (need bill_to backed by a real role#{' + a workorder assignment' if needs_assignment})." unless template

    assignment = template.workorder_assignments.first
    base_attrs = {
      transaction_date: Date.current,
      due_date:         Date.current,
      bill_to:          template.bill_to,
      payable_to:       template.payable_to,
    }
    if assignment
      base_attrs[:object_invoices_attributes] = [{ invoiceable_id: assignment.id, invoiceable_type: 'Workorders::Assignment' }]
    end
    payload_probe_id = template.id
  end

  hidden = klass.create!(base_attrs.merge(
    description:      "#{FIXTURE_PREFIX}#{key} HIDDEN — excluded by sql_string filter",
    reference_number: "#{FIXTURE_PREFIX}#{key.to_s.upcase}-HIDDEN-#{stamp}",
  ))
  visible = klass.create!(base_attrs.merge(
    description:      "#{FIXTURE_PREFIX}#{key} VISIBLE — passes sql_string filter",
    reference_number: "#{FIXTURE_PREFIX}#{key.to_s.upcase}-VISIBLE-#{stamp}",
  ))

  payload_probe_id ||= visible.id   # client classes: the visible fixture is the probe
  fixtures[key] = { klass: klass, hidden: hidden, visible: visible, payload_probe_id: payload_probe_id }
  puts "  #{key}: hidden=#{hidden.id} visible=#{visible.id} payload_probe=#{payload_probe_id}"
end

hidden_ids = fixtures.values.map { |f| f[:hidden].id }
FILTER_SQL = "invoices.id NOT IN (#{hidden_ids.join(',')})".freeze
puts "\n  filtered-user sql_string: #{FILTER_SQL}"

# --- Step 3: permission groups + users ---------------------------------------

def find_or_make_qa_user!(email:, password:, organization_id:, permission_group_id:)
  user = User.find_by(email: email)
  if user
    user.update!(active: true, password: password, organization_id: organization_id, permission_group_id: permission_group_id)
    return user
  end
  person_addr = Addresses::GeneralAddress.create!(
    first_name: 'QA', last_name: email.split('@').first,
    address1: '1 QA Way', city: 'Haddon Heights', state: 'NJ', country: 'US',
    postal_code: '08035', phone: '0000000000', address_name: 'QA',
    default_address: true, active: true,
  )
  person = Entities::Person.create!(general_addresses: [person_addr])
  Roles::EntityRole::InternalEmployeeRole.create!(
    start_date: Time.now, active: true, entity_id: person.id, organization_entity_id: organization_id,
  )
  User.create!(
    active: true, email: email, password: password,
    organization_id: organization_id, person_id: person.id, permission_group_id: permission_group_id,
  )
end

def make_group_with_grants!(name:, description:, role_type:, grants:)
  group = Permissions::Group.find_by(name: name) || Permissions::Group.create!(
    name: name,
    description: description,
    internal_description: 'Auto-created by seeds/invoice-visibility-filters.rb (TANGO-86 QA).',
    internal_name: name.gsub(/[^A-Za-z0-9]+/, ' ').strip[0, 50],
    role_type: role_type,
  )
  set = Permissions::Set.find_by(permission_group_id: group.id) ||
        Permissions::Set.create!(name: name, permission_group_id: group.id)
  # Reset grants so re-runs yield exactly the intended rows.
  Permissions::Resource.where(permission_set_id: set.id).delete_all
  grants.each { |attrs| Permissions::Resource.create!(attrs.merge(permission_set_id: set.id)) }
  [group, set]
end

banner 'Building permission groups + users'

# NOTE deliberately NO readable_attrs: respond_with_filtered
# (application_controller.rb:221) calls .map on the hash value when a
# non-super-admin has non-empty readable attrs — which explodes on show's
# SINGLE record ({ invoices: record }) with "undefined method `map'" →
# unspecified_error. Pre-existing platform quirk (path unchanged by TANGO-86);
# the merged minitest grants also omit readable_attrs. Documented in the QA
# report as a finding.
invoice_read_attrs = ->(klass, extra = {}) {
  { action: 'read', resource: klass.name, can: true }.merge(extra)
}

filtered_group, filtered_set = make_group_with_grants!(
  name: "#{GROUP_PREFIX} SQL-filtered reader",
  description: "QA-only (TANGO-86): read on the 4 invoice/quote classes with a discriminating sql_string hiding specific records. Safe to delete with TANGO-86 fixtures.",
  role_type: ref_role_type,
  grants: CLASSES.values.map { |k| invoice_read_attrs.call(k, sql_string: FILTER_SQL) },
)
filtered_user = find_or_make_qa_user!(email: 'qa.tango86.filtered@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: filtered_group.id)

noread_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} No invoice read",
  description: 'QA-only (TANGO-86): NO grants on invoice/quote classes (read on Products::Product only) — drives the 401 class-level authorize cases.',
  role_type: ref_role_type,
  grants: [{ action: 'read', resource: 'Products::Product', can: true }],
)
noread_user = find_or_make_qa_user!(email: 'qa.tango86.noread@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: noread_group.id)

instancerule_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} Instance-rule denied",
  description: "QA-only (TANGO-86): read on the 4 classes with a DENYING instance_methods rule (total < 0; totals recalc to >= 0) — proves the restored authorize! (34b03ef84a) still 401s.",
  role_type: ref_role_type,
  grants: CLASSES.values.map { |k|
    invoice_read_attrs.call(k,
      instance_methods:   ['total'],
      instance_operators: [{ 'total' => '<' }],
      instance_values:    [{ 'total' => 0 }],
    )
  },
)
instancerule_user = find_or_make_qa_user!(email: 'qa.tango86.instancerule@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: instancerule_group.id)

joinsql_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} Join-referencing sql (info probe)",
  description: 'QA-only (TANGO-86): read on SubcontractorInvoice with sql_string referencing stores.* — model-check probe for index-vs-show join divergence. Not used over HTTP.',
  role_type: ref_role_type,
  grants: [invoice_read_attrs.call(Invoices::SubcontractorInvoice, sql_string: 'stores.id IS NULL OR stores.id IS NOT NULL')],
)
joinsql_user = find_or_make_qa_user!(email: 'qa.tango86.joinsql@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: joinsql_group.id)

# Vanilla reader — plain read grants, NO sql_string, NO instance rule. The
# "customer who doesn't use SQL-string visibility filters" (AC8 positive
# control): every fixture, hidden or visible, must load for this user.
vanilla_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} Vanilla reader (no filters)",
  description: 'QA-only (TANGO-86): bare read on the 4 classes, no sql_string, no instance rule — AC8 positive control (unaffected customer still sees everything).',
  role_type: ref_role_type,
  grants: CLASSES.values.map { |k| invoice_read_attrs.call(k) },
)
vanilla_user = find_or_make_qa_user!(email: 'qa.tango86.vanilla@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: vanilla_group.id)

# Qualifying instance rule (total >= 0; fixtures recalc to 0) — positive
# control for the instance-rule PATH: proves the denying persona's 401 comes
# from the instance block being live and discriminating, not a dead grant.
instancepass_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} Instance-rule qualifying",
  description: 'QA-only (TANGO-86): read on the 4 classes with a QUALIFYING instance_methods rule (total >= 0) — positive control; records must load.',
  role_type: ref_role_type,
  grants: CLASSES.values.map { |k|
    invoice_read_attrs.call(k,
      instance_methods:   ['total'],
      instance_operators: [{ 'total' => '>=' }],
      instance_values:    [{ 'total' => 0 }],
    )
  },
)
instancepass_user = find_or_make_qa_user!(email: 'qa.tango86.instancepass@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: instancepass_group.id)

# Combined sql_string + instance_methods on ONE rule (subcontractor invoice
# only) — the real customer shape (visibility filter + amount threshold). Pins
# enforcement ORDERING across both new code paths: a record failing sql →
# missing_record (accessible_by wins before the block runs); a record passing
# sql but failing the instance block → 401 (authorize! after find). The
# instance rule denies EVERYTHING here (total < 0, totals recalc >= 0), so the
# visible fixture (passes sql) must 401 and the hidden fixture must missing_record.
combined_group, = make_group_with_grants!(
  name: "#{GROUP_PREFIX} SQL + instance combined",
  description: 'QA-only (TANGO-86): SubcontractorInvoice read with BOTH the discriminating sql_string AND a denying instance rule on one grant — pins sql-vs-instance enforcement ordering.',
  role_type: ref_role_type,
  grants: [invoice_read_attrs.call(Invoices::SubcontractorInvoice,
    sql_string:         FILTER_SQL,
    instance_methods:   ['total'],
    instance_operators: [{ 'total' => '<' }],
    instance_values:    [{ 'total' => 0 }],
  )],
)
combined_user = find_or_make_qa_user!(email: 'qa.tango86.combined@fexa.io', password: QA_PASSWORD, organization_id: org_id, permission_group_id: combined_group.id)

restricted_users = [filtered_user, noread_user, instancerule_user, joinsql_user, vanilla_user, instancepass_user, combined_user]
restricted_users.each do |u|
  u.reload
  assert(!u.super_admin?, "#{u.email} is NOT super_admin")
end
assert(filtered_user.resource_permissions.count == 4, 'filtered user resolves exactly 4 grants')
assert(filtered_user.resource_permissions.all? { |rp| rp.sql_string == FILTER_SQL }, 'filtered grants carry the discriminating sql_string')
assert(instancerule_user.resource_permissions.all? { |rp| rp.instance_methods == ['total'] }, 'instancerule grants carry the instance_methods rule')
assert(vanilla_user.resource_permissions.all? { |rp| rp.sql_string.blank? && rp.instance_methods.blank? }, 'vanilla grants carry no filters')
combined_rp = combined_user.resource_permissions.first
assert(combined_rp.sql_string == FILTER_SQL && combined_rp.instance_methods == ['total'], 'combined grant carries BOTH sql_string and instance rule')

# --- Step 4: Doorkeeper bearer tokens ----------------------------------------

banner 'Minting Doorkeeper bearer tokens'
oauth_app = Doorkeeper::Application.create!(
  name:         "#{FIXTURE_PREFIX}API Client",
  redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  owner:        admin_user,
)
tokens = {}       # label => raw token (spec reads these)
token_owners = {} # label => user_id (self-auditing: verify token→persona from artifacts)
{ filtered: filtered_user, noread: noread_user, instancerule: instancerule_user, joinsql: joinsql_user,
  vanilla: vanilla_user, instancepass: instancepass_user, combined: combined_user, admin: admin_user }.each do |label, u|
  t = Doorkeeper::AccessToken.create!(resource_owner_id: u.id, application_id: oauth_app.id, scopes: '', expires_in: 1.month.to_i)
  tokens[label] = t.token
  token_owners[label] = u.id
  puts "  #{label.to_s.ljust(12)} (resource_owner=#{u.id}): #{t.token[0, 12]}…"
end

# --- Step 5: ability-layer model checks --------------------------------------
# sql_string filters bite ONLY via accessible_by (ability.rb registers the rule
# with a block returning true when instance_methods is blank), so these checks
# must use accessible_by, never can?, for the hide/show questions.

banner 'Model checks (accessible_by layer)'
model_checks = []

filtered_ability = Ability.new(filtered_user)
admin_ability    = Ability.new(admin_user)
noread_ability   = Ability.new(noread_user)

CLASSES.each do |key, klass|
  f = fixtures[key]
  hidden_excluded  = !klass.accessible_by(filtered_ability).where(id: f[:hidden].id).exists?
  visible_included = klass.accessible_by(filtered_ability).where(id: f[:visible].id).exists?
  admin_sees_both  = klass.accessible_by(admin_ability).where(id: [f[:hidden].id, f[:visible].id]).count == 2
  model_checks << {
    ac: 'Direct-link enforcement #1 / Regression guard #2',
    name: "#{key}: filtered ability hides #{f[:hidden].id}, shows #{f[:visible].id}; admin sees both",
    passed: hidden_excluded && visible_included && admin_sees_both,
    detail: "hidden_excluded=#{hidden_excluded} visible_included=#{visible_included} admin_sees_both=#{admin_sees_both}",
  }
end

noread_all_denied = CLASSES.values.all? { |klass| !noread_ability.can?(:read, klass) }
model_checks << {
  ac: 'Response behavior #2',
  name: 'noread user cannot :read any of the 4 classes (class-level)',
  passed: noread_all_denied,
  detail: CLASSES.values.map { |k| "#{k.name}=#{noread_ability.can?(:read, k)}" }.join(', '),
}

# INFO — documents WHY the fix needed accessible_by: instance-level can? on a
# sql-hidden record returns true (the rule block passes when instance_methods
# is blank), so only relation scoping can enforce sql_string.
sub_hidden = fixtures[:subcontractor_invoice][:hidden]
model_checks << {
  ac: 'info',
  name: 'can?(:show, hidden) is TRUE for the filtered user (sql rules cannot deny at instance level) — accessible_by is the only enforcement point',
  passed: filtered_ability.can?(:show, sub_hidden) == true,
  detail: "can?(:show, hidden #{sub_hidden.id})=#{filtered_ability.can?(:show, sub_hidden)}; accessible_by excludes it=#{!Invoices::SubcontractorInvoice.accessible_by(filtered_ability).where(id: sub_hidden.id).exists?}",
}

# INFO — join-referencing sql_string probe. FINDING (contradicts the naive
# hypothesis that stores being in the eager_load tree would save the show
# path): Rails aliases eager_load joins, so a raw `stores.*` reference resolves
# on NEITHER path — both raise PG::UndefinedTable. Net effect of the fix: a
# customer whose visibility filter names any table other than `invoices` now
# HARD-FAILS direct-link show (surfaced as a handled invalid_request), where
# pre-fix they silently received the record. Sized by prod data → OQ2.
joinsql_ability = Ability.new(joinsql_user)
probe_id = fixtures[:subcontractor_invoice][:visible].id
index_outcome =
  begin
    n = Invoices::SubcontractorInvoice.accessible_by(joinsql_ability).where(id: probe_id).count
    "index-path OK (count=#{n})"
  rescue StandardError => e
    "index-path RAISED #{e.class}: #{e.message.lines.first&.strip}"
  end
show_outcome =
  begin
    # .to_a (not .count) — count strips eager_load joins, which would falsely
    # reproduce the index-path failure. The controller show path materializes.
    n = Invoices::SubcontractorInvoice.accessible_by(joinsql_ability).eager_load(stores: :default_address).where(id: probe_id).to_a.size
    "show-path OK (count=#{n})"
  rescue StandardError => e
    "show-path RAISED #{e.class}: #{e.message.lines.first&.strip}"
  end
model_checks << {
  ac: 'info',
  name: 'join-referencing sql_string (stores.*): both index-path AND show-path raise PG::UndefinedTable → direct-link show now hard-fails for non-invoices-table filters (OQ2 regression class)',
  passed: true,   # informational — outcome lives in detail
  detail: "#{index_outcome}; #{show_outcome}",
}

# INFO — enforcement ordering on the COMBINED sql+instance rule, verified at the
# ability layer to corroborate the HTTP ordering test. sql-hidden record is
# excluded by accessible_by (never reaches the instance block); sql-visible
# record is in scope but can?(:show) is false (instance block denies).
combined_ability = Ability.new(combined_user)
c_hidden  = fixtures[:subcontractor_invoice][:hidden]
c_visible = fixtures[:subcontractor_invoice][:visible]
combined_hidden_scoped_out = !Invoices::SubcontractorInvoice.accessible_by(combined_ability).where(id: c_hidden.id).exists?
combined_visible_in_scope  = Invoices::SubcontractorInvoice.accessible_by(combined_ability).where(id: c_visible.id).exists?
combined_visible_denied    = combined_ability.can?(:show, c_visible) == false
model_checks << {
  ac: 'Regression guard #3',
  name: 'combined sql+instance rule: sql-hidden scoped out (→ missing_record), sql-visible in scope but instance-denied (→ 401)',
  passed: combined_hidden_scoped_out && combined_visible_in_scope && combined_visible_denied,
  detail: "hidden_scoped_out=#{combined_hidden_scoped_out} visible_in_scope=#{combined_visible_in_scope} visible_instance_denied=#{combined_visible_denied}",
}

model_checks.each { |c| puts "  [#{c[:passed] ? 'PASS' : 'FAIL'}] #{c[:name]} — #{c[:detail]}" }

# --- Step 6: manifest --------------------------------------------------------

TANGO_ROOT    = File.expand_path('..', __dir__)
MANIFEST_PATH = File.join(TANGO_ROOT, 'reports', 'seed-manifest-tango-86.json')
FileUtils.mkdir_p(File.dirname(MANIFEST_PATH))

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-86',
  source_seed:  'seeds/invoice-visibility-filters.rb',
  description:  'Hidden/visible invoice+quote pairs across the 4 affected classes, restricted users (sql-filtered / no-read / denying-instance-rule) with Doorkeeper bearer tokens, and accessible_by model checks. Spec asserts direct-link missing_record vs 401 vs full payload over live HTTP.',
  scope: {
    password: QA_PASSWORD,
    filter_sql: FILTER_SQL,
    users: {
      filtered:     { email: filtered_user.email,     user_id: filtered_user.id,     group_id: filtered_group.id },
      noread:       { email: noread_user.email,       user_id: noread_user.id,       group_id: noread_group.id },
      instancerule: { email: instancerule_user.email, user_id: instancerule_user.id, group_id: instancerule_group.id },
      joinsql:      { email: joinsql_user.email,      user_id: joinsql_user.id,      group_id: joinsql_group.id },
      vanilla:      { email: vanilla_user.email,      user_id: vanilla_user.id,      group_id: vanilla_group.id },
      instancepass: { email: instancepass_user.email, user_id: instancepass_user.id, group_id: instancepass_group.id },
      combined:     { email: combined_user.email,     user_id: combined_user.id,     group_id: combined_group.id },
      admin:        { email: admin_user.email,        user_id: admin_user.id,        super_admin: admin_user.super_admin? },
    },
    classes: CLASSES.keys.each_with_object({}) do |key, h|
      f = fixtures[key]
      h[key] = {
        model:            f[:klass].name,
        endpoint:         ENDPOINTS[key],
        hidden_id:        f[:hidden].id,
        hidden_ref:       f[:hidden].reference_number,
        visible_id:       f[:visible].id,
        visible_ref:      f[:visible].reference_number,
        payload_probe_id: f[:payload_probe_id],
      }
    end,
  },
  api_auth: {
    base_path:    '/api/v1',
    token_type:   'Bearer',
    tokens:       tokens,
    token_owners: token_owners,   # label => user_id, so the manifest self-audits token→persona
    oauth_application_id: oauth_app.id,
  },
  fixtures: CLASSES.keys.flat_map do |key|
    f = fixtures[key]
    [
      { id: f[:hidden].id,  name: f[:hidden].reference_number,  active: true, purpose: "#{f[:klass].name} hidden by the filtered user's sql_string — direct link must return missing_record." },
      { id: f[:visible].id, name: f[:visible].reference_number, active: true, purpose: "#{f[:klass].name} visible sibling — direct link must return the record." },
    ]
  end,
  model_checks: model_checks,
}
File.write(MANIFEST_PATH, JSON.pretty_generate(manifest))

banner 'TANGO-86 fixtures ready'
CLASSES.each_key { |key| f = fixtures[key]; puts "  #{key.to_s.ljust(22)} hidden=#{f[:hidden].id}  visible=#{f[:visible].id}" }
puts "Users: filtered=#{filtered_user.id} noread=#{noread_user.id} instancerule=#{instancerule_user.id} joinsql=#{joinsql_user.id} vanilla=#{vanilla_user.id} instancepass=#{instancepass_user.id} combined=#{combined_user.id}"
puts "Model checks: #{model_checks.count { |c| c[:passed] }}/#{model_checks.size} passed"
puts "Manifest: #{MANIFEST_PATH}"
puts 'Re-run safely with: npm run seed:invoice-visibility-filters'
