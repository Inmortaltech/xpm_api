# PM & PMO Module — Backend

Ye module PM (Project Manager) aur PMO (Project Allocation) section ke saare
frontend features ko live karta hai.

## 1. Database setup (ek baar)

```bash
mysql -u root xmp_db < db_bkp/xmp_db_pm_pmo_module.sql
```

Ye script idempotent hai (dubara chalane par error nahi). Ye banati hai:

| Object | Kaam |
|---|---|
| `projects` ke naye columns | `request_status`, `decline_reason`, `project_manager_id`, `technical_lead`, `technology`, `methodology`, `resource_allocations`, `assigned_at`, `pm_responded_at` |
| `sub_projects` | Board task groups / phases |
| `required_resources` | PM ki additional resource requests |
| `boards` | Kanban tasks (Board + Backlog tab) |
| `board_columns` | Per-project custom columns + WIP limit |
| `project_discussions` | Discussion tab |
| `project_pm_history` | Assign / re-allocate / accept / decline ka audit trail (Denied PM History modal) |

> Note: agar aap SQL file na bhi chalao, controllers pehli request par tables/columns
> khud bana lete hain (`ensurePmSchema` / `ensureBoardSchema`). SQL file recommended hai
> kyunki usme indexes + seed data bhi hai.

## 2. Endpoints

### `/api/projectManager` (JSON body unless noted)

| Method | Path | Body | Frontend |
|---|---|---|---|
| POST | `/get_projectsByPm` | `{ pm_id }` | NewAssignedProjectPage, MyProjectsPage |
| POST | `/project_approvalBYPM` | `{ pm_id, project_id, request_status: 'Accept'\|'Declined', reason }` | Accept / Decline |
| POST | `/create_requiredResource` | `{ pm_id, project_id, resources_id, role, required_resource, status }` | Add Required Resource modal |
| POST | `/get_pmBacklog` | `{ pm_id }` | ProjectBacklogsSection |
| POST | `/assign_project` | `{ project_id, pm_id, project_manager }` (FormData ok) | PMO assign |
| POST | `/update_project_milestone` | `{ project_id, milestones: [...] }` | Gantt / milestone edit |
| GET | `/denied_pm_history?search=` | — | Denied PM History modal |

### `/api/users`

| Method | Path | Body | Frontend |
|---|---|---|---|
| POST | `/get_BoardsByResource` | `{ resource_id, type, project_id }` | Board tab |
| POST | `/create_board` | `{ project_id, sub_project_id, status, resource_id, pm_id, title, priority?, due_date? }` | Board — add card |
| POST | `/update_board` | `{ board_id, title?\|priority?\|due_date?\|resource_id?\|description? }` | Board — edit |
| POST | `/update_boardStatus` | `{ board_id, status }` | Board — drag/drop |
| POST | `/delete_board` | `{ board_id }` | Board — delete (soft) |
| POST | `/get_userDiscussion` | FormData: `resource_id, type` | Discussion tab |
| POST | `/create_discussion` | FormData: `project_id, project_name, project_scope, resource_id, type, sender_name, attachment?` | (helper — UI se abhi call nahi hota) |

### `/api/admin`

| Method | Path | Body | Frontend |
|---|---|---|---|
| POST | `/re-allocated` | FormData: `id, pm_id, project_manager, status` | CreateProjectPage — Assign PM / re-allocate |

## 3. Response shape

Sab endpoints `{ success: boolean, message?, data? }` return karte hain.
List endpoints me `{ success, count, data: [...] }`.

## 4. Flow

```
PMO (CreateProjectPage)
  ├─ Create Project (wizard)  ── project_manager_id set, request_status = 'Pending'
  └─ Assign / Re-allocate PM  ── /api/admin/re-allocated  ->  request_status = 'Pending', status = 're-allocated'
                                                              + project_pm_history row

PM (NewAssignedProjectPage)
  ├─ get_projectsByPm         ── apne assigned projects (request_status ke saath)
  ├─ Accept                   ── project_approvalBYPM {request_status:'Accept'}  -> status='Accepted'
  │                              (optional) create_requiredResource x N
  └─ Decline                  ── project_approvalBYPM {request_status:'Declined', reason}  -> status='Deny'
                                 + project_pm_history row  ->  Denied PM History modal me dikhta hai

PM (MyProjectsPage)
  ├─ Overview / Financial     ── get_projectsByPm ka data
  ├─ Board tab                ── get_BoardsByResource / create_board / update_board / update_boardStatus / delete_board
  ├─ Backlogs tab             ── get_pmBacklog
  └─ Discussion tab           ── get_userDiscussion
```
