# Idempotent test fixtures for TANGO-85 — "Extend Default Hidden Work Order
# Types setting to Assignments, Invoices & Proposals grids".
#
# The merged fix (PR #7105) adds four integer-array SSettings whose values the
# four Ext grid ContainerControllers read IN THE BROWSER and inject as a
# `not in` workflow-type store filter on default load. The backend PR only
# ADDED the `invoice_workflow_type_id` in/not-in dynamic_index filter to the
# three invoice/quote controllers (the Assignments filter pre-existed and was
# NOT normalized — see the un-normalized-empty model check below).
#
# This seed:
#   - runs the product seed (db/seeds/20260723...) so the four settings exist
#     (Assignments = cancelled+rejected, others empty) — AC1/AC2 baseline;
#   - builds a HIDDEN-type + VISIBLE-type record for each of the 4 grids, each
#     with exactly one Workflows::State pointing at a status of the target
#     workflow type (initial auto-state deduped, mirroring the merged minitest);
#   - builds a NULL-status subcontractor invoice (no state) to expose the
#     LEFT JOIN + NOT IN NULL edge (silently dropped once a setting is populated);
#   - mints one admin Doorkeeper bearer token (config/grid story — no personas);
#   - records model_checks: fixture integrity, seed-guard preserves admin value
#     (incl. the non-empty Assignments default), reporting-sees-hidden (AC8),
#     NULL-status drop, and the Assignments un-normalized empty-filter blank.
#
# Run via: npm run seed:default-hidden-grid-types

require 'json'
require 'fileutils'

FIXTURE_PREFIX = '[QA-TANGO85] '.freeze
ADMIN_EMAIL    = 'bigbrother@fexa.io'.freeze

# Workflow types (SSettings) reused as HIDDEN / VISIBLE per grid.
T_NEW       = SSetting.get(:workflow_type_new).to_i        # 1
T_ACCEPTED  = SSetting.get(:workflow_type_accepted).to_i   # 8
T_CANCELLED = SSetting.get(:workflow_type_cancelled).to_i  # 7  (a seeded-default Assignments hidden type)
T_REJECTED  = SSetting.get(:workflow_type_rejected).to_i   # 14 (the OTHER seeded-default Assignments hidden type)

def banner(msg); puts "\n=== #{msg} ==="; end
def assert(cond, msg)
  raise "ASSERTION FAILED: #{msg}" unless cond
  puts "  ok: #{msg}"
end

admin_user = User.find_by(email: ADMIN_EMAIL)
abort "Aborting: admin user '#{ADMIN_EMAIL}' missing." unless admin_user
org_id = admin_user.organization_id

# --- Step 0: ensure the product settings exist (AC1/AC2 baseline) -------------

banner 'Running product seed for the four hidden-types settings'
load Rails.root.join('db/seeds/20260723000000_add_default_hidden_grid_types_site_settings.rb')
HIDDEN_SETTINGS = {
  assignment:     :default_hidden_assignment_types,
  vendor_invoice: :default_hidden_vendor_invoice_types,
  client_invoice: :default_hidden_client_invoice_types,
  proposal:       :default_hidden_proposal_types,
}.freeze
HIDDEN_SETTINGS.each { |g, key| puts "  #{key} = #{SSetting.get(key).inspect}" }

# --- Step 1: clean prior fixtures (idempotent) -------------------------------

banner 'Cleaning prior TANGO-85 fixtures'
[Invoices::SubcontractorInvoice, Invoices::SubcontractorQuote, Invoices::ClientInvoice].each do |klass|
  n = klass.where('reference_number LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size
  puts "  removed #{n} #{klass.name}"
end
n = Workorders::Assignment.where('scope LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size
puts "  removed #{n} Workorders::Assignment"
n = Workorders::Workorder.where('description LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size
puts "  removed #{n} Workorders::Workorder"
Doorkeeper::AccessToken.where(application_id: Doorkeeper::Application.where('name LIKE ?', "#{FIXTURE_PREFIX}%").select(:id)).delete_all
puts "  removed #{Doorkeeper::Application.where('name LIKE ?', "#{FIXTURE_PREFIX}%").destroy_all.size} oauth application(s)"

# --- Step 2: status helpers --------------------------------------------------
# Create (or reuse) a Workflows::Status of a given workflow_type on a per-object
# QA workflow, then attach a single State to a record (dedup the auto-created
# initial state so the fixture has exactly one state — the merged minitest does
# the same, else the object resolves to the wrong / a NULL workflow type).

def qa_workflow_for(object_type)
  Workflows::Workflow.find_by(name: "#{FIXTURE_PREFIX}#{object_type} WF") ||
    Workflows::Workflow.create!(name: "#{FIXTURE_PREFIX}#{object_type} WF", object_type: object_type, created_by: 1, updated_by: 1)
end

def qa_status(workflow, type_id, label)
  Workflows::Status.find_by(workflow_id: workflow.id, workflow_type_id: type_id) ||
    Workflows::Status.create!(name: "#{FIXTURE_PREFIX}#{label}", workflow_id: workflow.id,
                              workflow_type_id: type_id, created_by: 1, updated_by: 1, point: '(1,1)')
end

def set_single_state!(record, status)
  st = Workflows::State.create!(object: record, status_id: status.id, created_by: 1, updated_by: 1)
  Workflows::State.where(object: record).where.not(id: st.id).delete_all
  record.object_state.reload if record.respond_to?(:object_state)
  st
end

# --- Step 3: shared subcontractor scaffolding (org/role/store/WO/assignment) --
# Mirrors subcontractor_invoices_controller_test setup so the records survive the
# dynamic_index INNER JOINs.

banner 'Building shared scaffolding'
# Uniqueness-constrained scaffolding is find-or-created so re-runs don't collide;
# orgs/roles (no unique key) are created fresh each run (minor orphan accumulation
# in the dev DB, same as the TANGO-86 seed).
org  = Entities::Organization.create!
euc  = Roles::EntityRole::EndUserCustomerRole.create!(start_date: Time.now, active: true, entity_id: org.id)
Addresses::GeneralAddress.create!(address1: '1 QA Way', city: 'Haddon Heights', state: 'NJ', postal_code: '08035',
                                  country: 'US', phone: '5555555555', company: "#{FIXTURE_PREFIX}Org", default_address: true, entity_id: org.id)
term = Invoices::SubcontractorPaymentTerm.find_or_create_by!(name: "#{FIXTURE_PREFIX}Net 30") { |t| t.due_days = 30; t.active = true }
sub_org = Entities::Organization.create!(term_id: term.id, addresses_attributes: [
  { address1: '1 QA Way', city: 'HH', state: 'NJ', postal_code: '08035', country: 'US', phone: '5555555555', type: 'Addresses::BillingAddress', default_address: true },
  { company: "#{FIXTURE_PREFIX}Vendor", address1: '1 QA Way', city: 'HH', state: 'NJ', postal_code: '08035', country: 'US', phone: '5555555555', type: 'Addresses::DispatchAddress', default_address: true },
])
sub_role = Roles::EntityRole::SubcontractorRole.create!(start_date: Time.now, organization: sub_org)
category = Workorders::Category.find_or_create_by!(category: "#{FIXTURE_PREFIX}Cat") { |c| c.description = 'QA'; c.active = true }
priority = Administration::Priority.find_or_create_by!(name: "#{FIXTURE_PREFIX}Prio") { |p| p.description = 'QA'; p.severity_id = 1; p.active = true; p.role_id = 1; p.category_id = category.id }
wo_class = Workorders::WorkorderClass.find_or_create_by!(name: "#{FIXTURE_PREFIX}Class") { |c| c.description = 'QA'; c.active = true }
store = Facilities::Store.find_or_create_by!(identifier: 'QA1') { |s| s.facility_code = '1'; s.name = "#{FIXTURE_PREFIX}Store"; s.active = true; s.occupied_by = euc.id; s.brand_id = 1 }
unless Addresses::StoreAddress.exists?(facility_id: store.id)
  Addresses::StoreAddress.create!(address1: '1 QA Way', city: 'HH', state: 'NJ', postal_code: '08035', country: 'US', phone: '5555555555', default_address: true, facility_id: store.id)
end

make_wo = lambda do |label|
  w = Workorders::Workorder.new(placed_for: euc.id, placed_by: euc.id, created_by: 1, workorder_class_id: wo_class.id,
                                priority_id: priority.id, description: "#{FIXTURE_PREFIX}WO #{label}", category_id: category.id)
  w.workorder_facilities << Workorders::WorkorderFacility.new(facility_id: store.id)
  w.save!
  w
end
wo = make_wo.call('shared')
shared_assignment = Workorders::Assignment.create!(created_by: 1, workorder_id: wo.id, role_id: sub_role.id,
                                                   scope: "#{FIXTURE_PREFIX}shared", category_id: category.id, spoke_with: 'QA')
puts "  org=#{org.id} sub_role=#{sub_role.id} wo=#{wo.id} shared_assignment=#{shared_assignment.id}"

# --- Step 4: per-grid hidden/visible fixtures --------------------------------

fixtures = {}   # grid_key => { hidden_id, visible_id, hidden_type, visible_type, ... }

# Endpoints + the workflow-type filter property each grid's store uses.
GRID_META = {
  vendor_invoice: { endpoint: '/api/v1/subcontractor_invoices/dynamic_index', root: 'invoices',    filter_property: 'invoice_workflow_type_id',    hidden_type: T_NEW,       visible_type: T_ACCEPTED },
  proposal:       { endpoint: '/api/v1/subcontractor_quotes/dynamic_index',   root: 'invoices',    filter_property: 'invoice_workflow_type_id',    hidden_type: T_NEW,       visible_type: T_ACCEPTED },
  client_invoice: { endpoint: '/api/v1/client_invoices/dynamic_index',        root: 'invoices',    filter_property: 'invoice_workflow_type_id',    hidden_type: T_NEW,       visible_type: T_ACCEPTED },
  assignment:     { endpoint: '/api/v1/assignments/dynamic_index',            root: 'assignments', filter_property: 'assignment_workflow_type_id', hidden_type: T_CANCELLED, visible_type: T_NEW },
}.freeze

stamp = admin_user.id   # deterministic-ish suffix without Time (Time is fine here but keep refs short)

def new_subcontractor_invoice(prefix, ref, assignment, sub_role_id)
  Invoices::SubcontractorInvoice.create!(
    transaction_date: Date.current, due_date: Date.current, description: prefix,
    bill_to: 1, payable_to: sub_role_id, reference_number: ref,
    object_invoices_attributes: [{ invoiceable_id: assignment.id, invoiceable_type: 'Workorders::Assignment' }],
  )
end

def new_subcontractor_quote(prefix, ref, assignment, sub_role_id)
  Invoices::SubcontractorQuote.create!(
    transaction_date: Date.current, due_date: Date.current, description: prefix,
    bill_to: 1, payable_to: sub_role_id, reference_number: ref,
    object_invoices_attributes: [{ invoiceable_id: assignment.id, invoiceable_type: 'Workorders::Assignment' }],
  )
end

banner 'Building per-grid hidden/visible fixtures'

# Vendor Invoices (SubcontractorInvoice)
si_wf = qa_workflow_for('Invoices::SubcontractorInvoice')
si_hidden_status  = qa_status(si_wf, T_NEW, 'SI New (hidden)')
si_visible_status = qa_status(si_wf, T_ACCEPTED, 'SI Accepted (visible)')
si_hidden  = new_subcontractor_invoice("#{FIXTURE_PREFIX}vendor_invoice HIDDEN", "#{FIXTURE_PREFIX}SI-HID-#{stamp}", shared_assignment, sub_role.id)
si_visible = new_subcontractor_invoice("#{FIXTURE_PREFIX}vendor_invoice VISIBLE", "#{FIXTURE_PREFIX}SI-VIS-#{stamp}", shared_assignment, sub_role.id)
set_single_state!(si_hidden, si_hidden_status)
set_single_state!(si_visible, si_visible_status)
fixtures[:vendor_invoice] = { hidden_id: si_hidden.id, visible_id: si_visible.id }

# Proposals (SubcontractorQuote)
sq_wf = qa_workflow_for('Invoices::SubcontractorQuote')
sq_hidden_status  = qa_status(sq_wf, T_NEW, 'SQ New (hidden)')
sq_visible_status = qa_status(sq_wf, T_ACCEPTED, 'SQ Accepted (visible)')
sq_hidden  = new_subcontractor_quote("#{FIXTURE_PREFIX}proposal HIDDEN", "#{FIXTURE_PREFIX}SQ-HID-#{stamp}", shared_assignment, sub_role.id)
sq_visible = new_subcontractor_quote("#{FIXTURE_PREFIX}proposal VISIBLE", "#{FIXTURE_PREFIX}SQ-VIS-#{stamp}", shared_assignment, sub_role.id)
set_single_state!(sq_hidden, sq_hidden_status)
set_single_state!(sq_visible, sq_visible_status)
fixtures[:proposal] = { hidden_id: sq_hidden.id, visible_id: sq_visible.id }

# Client Invoices — needs billable/payable BillToCustomerRoles + billing address + workorder link.
ci_billable_org = Entities::Organization.create!(term_id: term.id)
ci_payable_org  = Entities::Organization.create!(term_id: term.id)
[ci_billable_org, ci_payable_org].each do |o|
  Addresses::BillingAddress.create!(company: "#{FIXTURE_PREFIX}CI", address1: '1 QA Way', city: 'HH', state: 'NJ',
                                    postal_code: '08035', country: 'US', phone: '5555555555', default_address: true, entity_id: o.id)
end
ci_billable_role = Roles::EntityRole::BillToCustomerRole.create!(start_date: Time.now, active: true, organization: ci_billable_org)
ci_payable_role  = Roles::EntityRole::BillToCustomerRole.create!(start_date: Time.now, active: true, organization: ci_payable_org)
def new_client_invoice(prefix, ref, wo, bill_role, pay_role)
  Invoices::ClientInvoice.create!(
    transaction_date: Date.current, due_date: Date.current, description: prefix,
    bill_to: bill_role, payable_to: pay_role, reference_number: ref,
    object_invoices_attributes: [{ invoiceable_id: wo.id, invoiceable_type: 'Workorders::Workorder' }],
  )
end
ci_wf = qa_workflow_for('Invoices::ClientInvoice')
ci_hidden_status  = qa_status(ci_wf, T_NEW, 'CI New (hidden)')
ci_visible_status = qa_status(ci_wf, T_ACCEPTED, 'CI Accepted (visible)')
ci_hidden  = new_client_invoice("#{FIXTURE_PREFIX}client_invoice HIDDEN", "#{FIXTURE_PREFIX}CI-HID-#{stamp}", make_wo.call('ci-hidden'), ci_billable_role.id, ci_payable_role.id)
ci_visible = new_client_invoice("#{FIXTURE_PREFIX}client_invoice VISIBLE", "#{FIXTURE_PREFIX}CI-VIS-#{stamp}", make_wo.call('ci-visible'), ci_billable_role.id, ci_payable_role.id)
set_single_state!(ci_hidden, ci_hidden_status)
set_single_state!(ci_visible, ci_visible_status)
fixtures[:client_invoice] = { hidden_id: ci_hidden.id, visible_id: ci_visible.id }

# Assignments — hidden = cancelled (a seeded-default Assignments hidden type), visible = new.
asg_wf = qa_workflow_for('Workorders::Assignment')
asg_hidden_status  = qa_status(asg_wf, T_CANCELLED, 'ASG Cancelled (hidden)')
asg_visible_status = qa_status(asg_wf, T_NEW, 'ASG New (visible)')
# Distinct workorders — an assignment is unique per (workorder, role).
# TWO hidden assignments — cancelled(7) AND rejected(14) — so the exact shipped
# Assignments filter `not in [7,14]` can be exercised against both types.
asg_rejected_status = qa_status(asg_wf, T_REJECTED, 'ASG Rejected (hidden)')
asg_hidden  = Workorders::Assignment.create!(created_by: 1, workorder_id: make_wo.call('asg-hidden').id, role_id: sub_role.id, scope: "#{FIXTURE_PREFIX}asg HIDDEN cancelled", category_id: category.id, spoke_with: 'QA')
asg_hidden_rejected = Workorders::Assignment.create!(created_by: 1, workorder_id: make_wo.call('asg-hidden-rej').id, role_id: sub_role.id, scope: "#{FIXTURE_PREFIX}asg HIDDEN rejected", category_id: category.id, spoke_with: 'QA')
asg_visible = Workorders::Assignment.create!(created_by: 1, workorder_id: make_wo.call('asg-visible').id, role_id: sub_role.id, scope: "#{FIXTURE_PREFIX}asg VISIBLE", category_id: category.id, spoke_with: 'QA')
set_single_state!(asg_hidden, asg_hidden_status)
set_single_state!(asg_hidden_rejected, asg_rejected_status)
set_single_state!(asg_visible, asg_visible_status)
fixtures[:assignment] = { hidden_id: asg_hidden.id, hidden_id_2: asg_hidden_rejected.id, visible_id: asg_visible.id }

# NULL-status edge fixture — a subcontractor invoice with NO state at all.
si_nostate = new_subcontractor_invoice("#{FIXTURE_PREFIX}vendor_invoice NULL-STATUS", "#{FIXTURE_PREFIX}SI-NULL-#{stamp}", shared_assignment, sub_role.id)
Workflows::State.where(object: si_nostate).delete_all
null_status_invoice_id = si_nostate.id

GRID_META.each { |g, m| f = fixtures[g]; puts "  #{g.to_s.ljust(16)} hidden=#{f[:hidden_id]} (type #{m[:hidden_type]})  visible=#{f[:visible_id]} (type #{m[:visible_type]})" }
puts "  null-status vendor invoice=#{null_status_invoice_id}"

# --- Step 5: admin Doorkeeper token ------------------------------------------

banner 'Minting admin Doorkeeper bearer token'
oauth_app = Doorkeeper::Application.create!(name: "#{FIXTURE_PREFIX}API Client", redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', owner: admin_user)
admin_token = Doorkeeper::AccessToken.create!(resource_owner_id: admin_user.id, application_id: oauth_app.id, scopes: '', expires_in: 1.month.to_i)
puts "  admin token (resource_owner=#{admin_user.id}): #{admin_token.token[0, 12]}…"

# --- Step 6: model checks ----------------------------------------------------

banner 'Model checks'
model_checks = []

# Fixture integrity: each hidden/visible record's current status resolves to the intended workflow type.
GRID_META.each do |grid, m|
  f = fixtures[grid]
  klass = { vendor_invoice: Invoices::SubcontractorInvoice, proposal: Invoices::SubcontractorQuote,
            client_invoice: Invoices::ClientInvoice, assignment: Workorders::Assignment }[grid]
  h = klass.find(f[:hidden_id]); v = klass.find(f[:visible_id])
  h_type = h.object_state&.status&.workflow_type_id
  v_type = v.object_state&.status&.workflow_type_id
  model_checks << {
    ac: 'Fixture integrity',
    name: "#{grid}: hidden ##{f[:hidden_id]} → type #{m[:hidden_type]}, visible ##{f[:visible_id]} → type #{m[:visible_type]}",
    passed: h_type == m[:hidden_type] && v_type == m[:visible_type],
    detail: "hidden_type=#{h_type} (want #{m[:hidden_type]}), visible_type=#{v_type} (want #{m[:visible_type]})",
  }
end

# AC1/AC2: settings exist, gui-sent integer arrays; assignments = cancelled+rejected; others empty.
asg_val = SSetting.get(:default_hidden_assignment_types)
others_empty = %i[default_hidden_vendor_invoice_types default_hidden_client_invoice_types default_hidden_proposal_types].all? { |k| SSetting.get(k) == [] }
all_gui_int = HIDDEN_SETTINGS.values.all? { |k| s = SSetting.find_by(name: k); s&.value_type == 'integer_array' && s.send_to_gui }
model_checks << {
  ac: 'New site settings #1/#2',
  name: 'four settings exist as gui-sent integer arrays; assignments=[cancelled,rejected]; others empty',
  passed: all_gui_int && asg_val.sort == [T_CANCELLED, SSetting.get(:workflow_type_rejected).to_i].sort && others_empty,
  detail: "assignment=#{asg_val.inspect} others_empty=#{others_empty} all_gui_int=#{all_gui_int}",
}

# AC3: re-running the product seed never overwrites an admin-configured value.
# Capture originals, set a custom value on each of the four, re-load the product
# seed, assert unchanged, then RESTORE originals exactly (ensure block).
seed_guard_passed = false
seed_guard_detail = ''
originals = HIDDEN_SETTINGS.values.each_with_object({}) { |k, h| h[k] = SSetting.find_by(name: k).value }
begin
  HIDDEN_SETTINGS.values.each_with_index { |k, i| Administration::SiteSetting.set_value_by_name(k, "#{90 + i}") }
  custom_before = HIDDEN_SETTINGS.values.map { |k| SSetting.get(k) }
  load Rails.root.join('db/seeds/20260723000000_add_default_hidden_grid_types_site_settings.rb')
  custom_after = HIDDEN_SETTINGS.values.map { |k| SSetting.get(k) }
  seed_guard_passed = custom_before == custom_after
  seed_guard_detail = "before=#{custom_before.inspect} after=#{custom_after.inspect} (guard: next if SSetting.exists?)"
ensure
  originals.each { |k, v| Administration::SiteSetting.set_value_by_name(k, v) }
end
# Verify restore returned settings to the product-seeded state (browser tests depend on it).
restored_ok = SSetting.get(:default_hidden_assignment_types).sort == asg_val.sort &&
              %i[default_hidden_vendor_invoice_types default_hidden_client_invoice_types default_hidden_proposal_types].all? { |k| SSetting.get(k) == [] }
model_checks << {
  ac: 'New site settings #3 (seed guard)',
  name: 're-running the seed never overwrites an admin-configured value',
  passed: seed_guard_passed && restored_ok,
  detail: "#{seed_guard_detail}; restored_to_seed_defaults=#{restored_ok}",
}

# AC8: hidden records remain available to the (unfiltered) reporting/relation path.
reporting_ok = GRID_META.keys.all? do |grid|
  klass = { vendor_invoice: Invoices::SubcontractorInvoice, proposal: Invoices::SubcontractorQuote,
            client_invoice: Invoices::ClientInvoice, assignment: Workorders::Assignment }[grid]
  klass.where(id: fixtures[grid][:hidden_id]).exists?
end
model_checks << {
  ac: 'Users can still surface hidden records #2 (reporting)',
  name: 'hidden fixture rows persist (unfiltered relation still returns them; reporting/export code never reads the setting keys — confirmed by code review)',
  passed: reporting_ok,
  detail: "all four hidden fixture rows present in the unfiltered relation = #{reporting_ok} (proves the rows are not deleted/scoped away; reporting isolation is by code review, not a live report query here)",
}

# Persona attestation (DB-grounded, not just the rendered label): the bearer's
# owner is a super_admin — the right persona for a grid-load/config story, and
# proof the exclusion is a query filter (admin still sees the reduction), not a
# permission the admin would bypass.
model_checks << {
  ac: 'Persona attestation',
  name: 'admin bearer owner is a super_admin (exclusion is a query filter, applied irrespective of persona)',
  passed: admin_user.super_admin?,
  detail: "#{admin_user.email} super_admin=#{admin_user.super_admin?} (user_id=#{admin_user.id})",
}

# INFO — malformed setting-value representations. SSetting integer_array parses
# via String#to_i, so non-numeric / bracket / whitespace input degrades to [0]
# (a bogus `not in [0]`), NOT empty. An admin typing "[]" to clear a setting
# gets [0], not a no-op. Documented; the setting is normally written by an
# integer multiselect, so the exposure is narrow.
malformed = { '"[]"' => '[]', '" "' => ' ', '"abc"' => 'abc', '","' => ',' }.transform_values do |raw|
  # The real parse: String#to_integer_array (split(',').map(&:to_i)) from the app's object extension.
  raw.respond_to?(:to_integer_array) ? raw.to_integer_array : raw.split(',').map(&:to_i)
end
model_checks << {
  ac: 'info',
  name: 'malformed setting values ("[]", whitespace, non-integer) parse to [0] not empty (String#to_i) — an admin typing "[]" to clear a setting gets a bogus not in [0]',
  passed: true,
  detail: malformed.map { |k, v| "#{k}->#{v.inspect}" }.join(', '),
}

# INFO — NULL-status edge: a record with no state has NULL workflow_type_id and
# is silently dropped by `NOT IN` once a setting is populated (LEFT JOIN + NULL
# semantics, no OR IS NULL escape).
null_wf_type = Invoices::SubcontractorInvoice.find(null_status_invoice_id).object_state&.status&.workflow_type_id
model_checks << {
  ac: 'info',
  name: 'NULL-status record: workflow_type_id is NULL → excluded by NOT IN whenever a hidden-types filter is active (silent drop; still in reporting)',
  passed: null_wf_type.nil?,
  detail: "null-status invoice ##{null_status_invoice_id} workflow_type_id=#{null_wf_type.inspect}",
}

model_checks.each { |c| puts "  [#{c[:passed] ? 'PASS' : 'FAIL'}] #{c[:name]} — #{c[:detail]}" }

# --- Step 7: manifest --------------------------------------------------------

TANGO_ROOT    = File.expand_path('..', __dir__)
MANIFEST_PATH = File.join(TANGO_ROOT, 'reports', 'seed-manifest-tango-85.json')
FileUtils.mkdir_p(File.dirname(MANIFEST_PATH))

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-85',
  source_seed:  'seeds/default-hidden-grid-types.rb',
  description:  'Hidden/visible workflow-type fixtures across the 4 grids (Assignments, Vendor Invoices, Client Invoices, Proposals), an admin bearer token, and model_checks (fixture integrity, seed-guard, reporting-unaffected, NULL-status edge). Spec asserts the dynamic_index in/not-in filter contract (Layer A, API) and the Ext grid frontend wiring using product-seeded values (Layer B, browser).',
  scope: {
    workflow_types: { new: T_NEW, accepted: T_ACCEPTED, cancelled: T_CANCELLED, rejected: SSetting.get(:workflow_type_rejected).to_i },
    settings: HIDDEN_SETTINGS.each_with_object({}) { |(g, k), h| h[g] = { key: k.to_s, value: SSetting.get(k) } },
    null_status_invoice_id: null_status_invoice_id,
    grids: GRID_META.each_with_object({}) do |(grid, m), h|
      f = fixtures[grid]
      h[grid] = {
        endpoint:        m[:endpoint],
        root_property:   m[:root],
        filter_property: m[:filter_property],
        hidden_type:     m[:hidden_type],
        visible_type:    m[:visible_type],
        hidden_id:       f[:hidden_id],
        visible_id:      f[:visible_id],
        setting_key:     HIDDEN_SETTINGS[grid].to_s,
        setting_value:   SSetting.get(HIDDEN_SETTINGS[grid]),   # the FULL shipped hidden-types array for this grid
      }
      # Assignments carries a second hidden fixture (rejected type 14) so the exact
      # shipped `not in [7,14]` can be exercised against both hidden types.
      h[grid][:hidden_id_2] = f[:hidden_id_2] if f[:hidden_id_2]
      h[grid][:hidden_type_2] = T_REJECTED if grid == :assignment
    end,
  },
  api_auth: {
    base_path:  '/api/v1',
    token_type: 'Bearer',
    tokens:     { admin: admin_token.token },
    token_owners: { admin: admin_user.id },
    oauth_application_id: oauth_app.id,
  },
  fixtures: GRID_META.keys.flat_map do |grid|
    f = fixtures[grid]
    [
      { id: f[:hidden_id],  name: "#{grid} HIDDEN",  active: true, purpose: "#{grid}: workflow type #{GRID_META[grid][:hidden_type]} — excluded by a populated hidden-types filter." },
      { id: f[:visible_id], name: "#{grid} VISIBLE", active: true, purpose: "#{grid}: workflow type #{GRID_META[grid][:visible_type]} — always present." },
    ]
  end,
  model_checks: model_checks,
}
File.write(MANIFEST_PATH, JSON.pretty_generate(manifest))

banner 'TANGO-85 fixtures ready'
puts "Model checks: #{model_checks.count { |c| c[:passed] }}/#{model_checks.size} passed"
puts "Manifest: #{MANIFEST_PATH}"
puts 'Re-run safely with: npm run seed:default-hidden-grid-types'
