#version 460
#extension GL_EXT_nonuniform_qualifier : enable
#ifdef RAY_TRACE
#extension GL_EXT_ray_query : require
#endif		
#define PI 3.1415926538
struct Vertex{
	vec3 position; // 0 - 16
	vec3 normal;   // 16 - 16
	vec2 tex_coord;// 32 - 8
	int material_index;   // 40 - 4 - the index of the material to use
};
struct Material{
	float k_a;
	float k_d;
	float k_s;
	int texture_index;
};
struct SceneNode{
	int IndexBuferIndex;
	int NumTriangles;
	int NumChildren;
	int childrenIndex;
	int Index;
	int level;
	uint numEven;
	uint numOdd;
	uint tlasNumber;
};
const uint LIGHT_ON = 1;
const uint LIGHT_TYPE_POINT = 2;
const uint LIGHT_TYPE_DIRECTIONAL = 4;
const uint LIGHT_DISTANCE_IGNROE = 8;
const uint LIGHT_DISTANCE_LINEAR = 16;
const uint LIGHT_DISTANCE_QUADRATIC = 32;
const uint LIGHT_IGNORE_MAX_DISTANCE = 64;
const uint LIGHT_USE_MIN_DST = 128;
struct Light{
	vec3 position;
	uint type;
	vec3 intensity;
	float maxDst;
	vec3 direction;
	float minDst;
};

layout(binding = 0, set = 0) uniform SceneData{
	uint numVertices;
	uint numTriangles;
	uint numSceneNodes;
	uint numNodeIndices;
	uint numLights;
	uint rootSceneNode;
};

layout(binding = 1, set = 0) buffer VertexBuffer { Vertex[] vertices; };
layout(binding = 2, set = 0) buffer IndexBuffer { int[] indices; };
layout(binding = 3, set = 0) buffer MaterialBuffer { Material[] materials; };
layout(binding = 4, set = 0) buffer LightBuffer {Light[] lights;};
// Scene nodes
layout(binding = 5, set = 0) buffer NodeTransforms { mat4[] transforms; }; // correleates 1-1 with NodeBuffer, is alone cause of alignment
layout(binding = 6, set = 0) buffer NodeBuffer { SceneNode[] nodes;}; // the array of sceneNodes
layout(binding = 7, set = 0) buffer ChildBuffer { uint[] childIndices;}; // the index array for node children

layout(binding = 8, set = 1) uniform sampler samp;
layout(binding = 9, set = 1) uniform texture2D textures[];

layout(binding = 10, set = 2) uniform FrameData {
	mat4 view_to_world;
	uint width;
	uint height;
	// Render settings struct
	float fov;
	uint displayUV;
	uint displayTex;
	uint displayTriangles;
	uint displayLights;
};

#ifdef RAY_TRACE
layout(binding = 11, set = 3) uniform accelerationStructureEXT[] tlas;
#endif

layout(location = 0) in vec3 fragColor;

layout(location = 0) out vec4 outColor;

const float t_min = 1.0e-4f;
const float EPSILON = 0.0000001;

bool rayTriangleIntersect(vec3 rayOrigin, vec3 rayDirection, out vec3 tuv, vec3 v0, vec3 v1, vec3 v2) { 
    vec3 edge1 = v1 - v0;
	vec3 edge2 = v2 - v0;
    vec3 h = cross(rayDirection, edge2);
    float a = dot(edge1, h);
    if (a > -EPSILON && a < EPSILON)
        return false;    // This ray is parallel to this triangle.
    float f = 1.0f/a;
    vec3 s = rayOrigin - v0;
    float u = f * dot(s, h);
    if (u < 0.0 || u > 1.0)
        return false;
    vec3 q = cross(s, edge1);
    float v = f * dot(rayDirection, q);
    if (v < 0.0 || u + v > 1.0)
        return false;
    // At this stage we can compute t to find out where the intersection point is on the line.
    float t = f * dot(edge2, q);
    if (t > t_min) // ray intersection
    {
		tuv = vec3(t,u,v);
        vec3 outIntersectionPoint = rayOrigin + rayDirection * t;
        return true;
    }
    else // This means that there is a line intersection but not a ray intersection.
        return false;
} 
bool vertexIntersect(vec3 rayOrigin, vec3 rayDir, vec3 postion){
	float t;
	float epsilon = 0.1f;
	vec3 v = rayOrigin - postion;
	float a = rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z;
	float b = 2 * rayDir.x * v.x + 2 * rayDir.y * v.y + 2 * rayDir.z * v.z;
	float c = v.x * v.x + v.y * v.y + v.z * v.z - epsilon * epsilon;
	float disciminant = b * b - 4 * a * c;
	if (disciminant < 0) return false;

	if (disciminant == 0) {
		t = -b / (2 * a);
		if (t < t_min) return false;
		return true;
	}
	disciminant = sqrt(disciminant);
	float t1 = (-b - disciminant)/(2*a);
	float t2 = (-b + disciminant)/(2*a);
	//this only works because a is strictly positive
	if (t2 < t_min) return false;
	if (t1 < t_min) {
		t = t2;
		return true;
	}
	t = t1;
	return true;
}
bool ray_trace_loop(vec3 rayOrigin, vec3 rayDirection, float t_max, uint root, out vec3 tuv, out int triangle_index) {
#ifdef RAY_TRACE
	float min_t = 1.0e-3f;
	float max_t = t_max;
	SceneNode node = nodes[root];
	tuv = vec3(0);
	rayQueryEXT ray_query;
	rayQueryInitializeEXT(ray_query, tlas[node.tlasNumber], 0, 0xFF, rayOrigin, min_t, rayDirection, max_t);
	while(rayQueryProceedEXT(ray_query)){
		uint type = rayQueryGetIntersectionTypeEXT(ray_query, false);
		switch(type){
			case gl_RayQueryCandidateIntersectionTriangleEXT:
				// might want to check for opaque
				rayQueryConfirmIntersectionEXT(ray_query);
				break;
			case gl_RayQueryCandidateIntersectionAABBEXT:
				uint iIdx = rayQueryGetIntersectionInstanceIdEXT(ray_query, false);
				//if (iIdx != 0) break;
				// TODO rayQuery stuff
				float t = rayQueryGetIntersectionTEXT(ray_query, false);
				rayQueryGenerateIntersectionEXT(ray_query, t);
				break;
		}
	}
	uint commitedType = rayQueryGetIntersectionTypeEXT(ray_query, true);
	if(commitedType == gl_RayQueryCommittedIntersectionTriangleEXT ) {
		triangle_index = rayQueryGetIntersectionPrimitiveIndexEXT(ray_query, true);
		tuv.x = rayQueryGetIntersectionTEXT(ray_query, true);
		vec2 uv = rayQueryGetIntersectionBarycentricsEXT(ray_query, true);
		tuv.y = uv.y;
		tuv.z = uv.x;
		return true;
	}
	if(commitedType == gl_RayQueryCommittedIntersectionGeneratedEXT) {
		triangle_index = -1;
		uint iIdx = rayQueryGetIntersectionInstanceIdEXT(ray_query, true);
		uint cIdx = rayQueryGetIntersectionInstanceCustomIndexEXT(ray_query, true);
		uint pIdx = rayQueryGetIntersectionPrimitiveIndexEXT(ray_query,true);
		SceneNode next;
		if(node.numEven>0 && iIdx == 0){ // only do the even case for instance 0 and if there are even nodes, otherwise any aabb is ODD
			// handle even child
			next = nodes[childIndices[node.childrenIndex+pIdx]];
			outColor = vec4(next.tlasNumber & 1, next.tlasNumber & 2, next.tlasNumber & 4, 1);
		} else {
			// handle odd child
			SceneNode directChild = nodes[cIdx]; // use the custom index to take a shortcut
			next = nodes[childIndices[directChild.childrenIndex + pIdx]];
		}
		vec3 newRayOrigin = rayQueryGetIntersectionObjectRayOriginEXT(ray_query, true);
		vec3 newRayDirection = rayQueryGetIntersectionObjectRayDirectionEXT(ray_query, true);

		rayQueryEXT next_query;
		rayQueryInitializeEXT(next_query, tlas[next.tlasNumber], 0, 0xFF, newRayOrigin, min_t, newRayDirection, max_t);
		while(rayQueryProceedEXT(next_query)){
			if(rayQueryGetIntersectionTypeEXT(next_query, false) == gl_RayQueryCandidateIntersectionTriangleEXT){
				rayQueryConfirmIntersectionEXT(next_query);
			}
		}
		if(rayQueryGetIntersectionTypeEXT(next_query, true) == gl_RayQueryCommittedIntersectionTriangleEXT ) {
			triangle_index = -1;
			return true;
		}
	}
	return false;
#endif
#ifndef RAY_TRACE
	vec3 tuv_next;
	tuv.x = t_max;
	triangle_index = -1;
	for(int i = 0;i<numTriangles;i++){
		Vertex vert_v0 = vertices[indices[i * 3]];
		Vertex vert_v1 = vertices[indices[i * 3 + 1]];
		Vertex vert_v2 = vertices[indices[i * 3 + 2]];

		vec3 v0 = vert_v0.position;
		vec3 v2 = vert_v1.position;
		vec3 v1 = vert_v2.position;
		if(rayTriangleIntersect(rayOrigin, rayDirection, tuv_next, v0, v1, v2) ){
			if(tuv_next.x < tuv.x) {
				tuv = tuv_next;
				triangle_index = i;
			}
		}
	}
	if(triangle_index == -1){
		return false;
	}
	return true;
#endif
}

void shadeFragment(vec3 P, vec3 V, vec3 tuv, int triangle) {
	Vertex v0 = vertices[indices[triangle * 3]];
	Vertex v1 = vertices[indices[triangle * 3 + 1]];
	Vertex v2 = vertices[indices[triangle * 3 + 2]];


	float w = 1 - tuv.y - tuv.z;
	float u = tuv.y;
	float v = tuv.z;
	
	if(displayUV != 0){ // debug
		outColor = vec4(u,v,0,1);
		return;
	}
	// compute interpolated Normal and Tex
	vec3 N = w * v0.normal + v * v1.normal + u * v2.normal;
	N = normalize(N);
	vec2 tex = w * v0.tex_coord + v * v1.tex_coord + u * v2.tex_coord;

	if(displayTex != 0){	// debug
		outColor = vec4(tex.xy,0,1);
		return;
	}

	// get material and texture properties, if there are not set use default values
	float ka, kd, ks;
	vec3 color;
	if(v0.material_index < 0){
		ka = 0.3f; kd = 0.4f; ks = 0.3f;
		color = vec3(0.2,0.4,0.8);
	} else {
		Material m = materials[v0.material_index];
		ka = m.k_a;
		kd = m.k_d;
		ks = m.k_s;
		if(m.texture_index < 0)
			color = vec3(0.2,0.4,0.8);
		else
			color = texture(sampler2D(textures[m.texture_index], samp), tex).xyz;
	}
	float n = 1; // todo phong exponent
	// calculate lighting for each light source

	vec3 sum = vec3(0);
	for(int i = 0;i<numLights;i++){
		Light light = lights[i];

		if((light.type & LIGHT_ON) == 0){ // is the light on?
			continue;
		}
		vec3 tuvShadow;
		int index;

		vec3 L = light.position - P;
		float l_dst = length(L);
		if(l_dst > light.maxDst && (light.type & LIGHT_IGNORE_MAX_DISTANCE) == 0){ // is the light near enough to even matter
			continue;
		}
		float specular;
		float diffuse = kd;
		vec3 R = normalize(reflect(V, N));
		if((light.type & LIGHT_TYPE_POINT) != 0){ // point light, check if it is visible and then compute KS via L vector
			vec3 LN = normalize(L);
			if(ray_trace_loop(P, LN, l_dst,rootSceneNode, tuvShadow, index)){ // is light source visible, shoot ray to lPos?
				continue;
			}
			specular = ks * pow(max(0,dot(R,LN)),n);
		} else if((light.type & LIGHT_TYPE_DIRECTIONAL) != 0) { // directional light, check if it is visible 
			if((light.type & LIGHT_USE_MIN_DST) != 0){ // shoot ray over minDst, if nothing is hit lighting is enabled
				if(ray_trace_loop(P, normalize(-light.direction), light.minDst,rootSceneNode, tuvShadow, index)){ // shoot shadow ray into the light source
					continue;
				}
				specular = ks * pow(max(0,dot(R,-light.direction)),n);
			} else { // directional light with fixed position, this is probably not correct
				if(ray_trace_loop(P, normalize(-light.direction), l_dst,rootSceneNode, tuvShadow, index)){
					continue;
				}
				specular = ks * pow(max(0,dot(R,-light.direction)),n);
			}
		}
		float l_mult = 0;
		if((light.type & LIGHT_DISTANCE_IGNROE	) != 0) {
			l_mult = 1;
		}
		if((light.type & LIGHT_DISTANCE_LINEAR) != 0) {
			l_mult = 1/l_dst;
		}
		if((light.type & LIGHT_DISTANCE_QUADRATIC) != 0) {
			l_mult = 1/(l_dst * l_dst);
		}
		sum += (specular+diffuse) * light.intensity * l_mult * color;
	}
	sum += ka * color;
	outColor = vec4(sum.xyz, 1);
}


void main() {
	// from https://www.scratchapixel.com/lessons/3d-basic-rendering/ray-tracing-generating-camera-rays/generating-camera-rays
	ivec2 xy = ivec2(gl_FragCoord.xy);
	float x = xy.x;
	float y = xy.y;

	float flt_height = height;
	float flt_width = width;
	vec4 origin_view_space = vec4(0,0,0,1);
	vec4 origin_world_space = view_to_world * origin_view_space;
	float z = flt_height/tan(PI / 180 * fov);
	vec4 direction_view_space = vec4(normalize(vec3((x - flt_width/2.f),  flt_height/2.f - y, -z)) , 0);
	vec4 direction_world_space = view_to_world * direction_view_space;

	vec3 rayOrigin = origin_world_space.xyz;
	vec3 rayDirection = direction_world_space.xyz;

	int triangle_index = -1;

	float t_max = 300;
	vec3 tuv;
	if(ray_trace_loop(rayOrigin, rayDirection, t_max,rootSceneNode, tuv, triangle_index)){
		if(triangle_index >= 0){
			vec3 P = rayOrigin + tuv.x * rayDirection;
			shadeFragment(P, rayDirection, tuv, triangle_index);
		} else {
			outColor = vec4(1,0,0,1);
		}
	}
	else {
		/*
		for(int i = 0;i<1;i++){
			if(vertexIntersect(rayOrigin, rayDirection, vec3(1,0,0))){
				outColor = vec4(1,0,0,1);
				return;
			}
			if(vertexIntersect(rayOrigin, rayDirection, vec3(0,1,0))){
				outColor = vec4(0,1,0,1);
				return;
			}
			if(vertexIntersect(rayOrigin, rayDirection, vec3(0,0,-1))){
				outColor = vec4(0,0,1,1);
				return;
			}
			if(vertexIntersect(rayOrigin, rayDirection, vec3(0,0,0))){
				outColor = vec4(1,1,1,1);
				return;
			}		
		}*/
		outColor = vec4(3, 215, 252, 255) /255;
	}
	return;
}