# Orbitworks FS Coding Challenge

## Challenge description

Your mission, should you choose to accept it, is to build a full-stack web application based on a custom Restful/GraphQL backend. The API exposes information about satellite passes (timestamped trajectories of satellites).

The application is expected to be map-centric and will privde 2 main functions.

1. Display passes on a map
The display of the satellite tracks is expected to be snappy. Over large time horizons this can result in very crowded display. To help visualizing the passes, the end user should be able to select a subset of satellites and to apply a timerange (min-max) filter. The map is expected to refresh quasi instantly to filter changes

2. Provide quick accesses list for next days
When the user selects a point on the map, then a geographic intersection is performed against the passes with a user selectable radius and a user-selectable start date and end date. The page should then show the selected portions of tracks that match the criteria.


**Your objective is to provide a user-friendly application with a variety of interesting features derived from the above 2 main functions.** This is a creative exercise, so there are no specific features that are explicitly required and you are encouraged to make any technical assumptions on your own. Try to highlight interactiveness and useability by paying attention to readability and synchronization of elements displayed on the map and in tabular views. Just make sure to document your decisions!

## Technical constraints

### General

We expect the app to be delivered as a deployment ready app, so pay attention to:
- Overall code formatting, readability and elegance
- Use ESLint, Styleint, Prettier
- Unit testing
- The quality of the documentation
- Use of SOTA CI/CD techniques
- Provide a dockerfile and docker-compose.yml
- Use typescript rather than vanilla javascript
- Use of Coding agents (Claude code, codex...) is allowed, the instructions and strategy used should then be documented

### Backend:

- use the attached geojson file that contains precalculated simulated satellite passes (10 spacecrafts) for one week
- the API can be built on node.js or python
- use DuckDB as the supporting database for dealing with geojson data and querying it efficiently (look at the spatial extension). If you dislike this requirement you can fall back to another choice provided it's justified
- use GraphQL or Restful APIs

### Frontend:

- use an existing open source mapping engine (maplibre GL JS, Mapbox, Leaflet, ...)
- map background should come from public open data repositories (openstreetmap), no internal hosting. Tip: prefer using vector tiles which provide rich styling capacity to streamline the map background
- use React or Vue framework
- don't put any effort into accessibility, just pay attention to readability of the information
- have a look at duckdb wasm, it could help providing in-browser geo-processing capacity if you feel like it

## Allocated time

We understand that this is a large task, and there is a short time (2-3 days) allocated to deliver. We will not evaluate you on the number of features but rather on the logic you followed, decision making process and capacity to explain your decisions. Incomplete work is acceptable if a plan for missing features is provided.
